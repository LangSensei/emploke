import { resolveDefaultAdoToken } from "./ado-token.js";
import { FetchError } from "./errors.js";
import type { EntryFile, Fetcher } from "./fetcher.js";
import { parseOrigin } from "./origin.js";

/**
 * Fetcher for `https://dev.azure.com/<org>/<project>/_git/<repo>?path=/<path>`
 * URIs (Azure DevOps Services only; on-prem TFS / Azure DevOps Server is
 * rejected at `parseOrigin` time).
 *
 * Two endpoints, both on the **Items API** version `7.1`:
 *
 *  - {@link AzureDevOpsFetcher.fetchFile} — single-file reads use
 *    `GET /_apis/git/repositories/{repo}/items?path={pathEnc}&api-version=7.1`
 *    with `Accept: application/octet-stream`. The response body is the
 *    raw file bytes (ADO sets `Content-Type: application/octet-stream;
 *    api-version=7.1` on success; the `; api-version=...` suffix is
 *    expected and harmless). The resolve path goes here — anchor files
 *    (SKILL.md / AGENTS.md / `<name>.json`) only.
 *
 *  - {@link AzureDevOpsFetcher.fetchTree} — directory installs use
 *    `GET /_apis/git/repositories/{repo}/items?scopePath={pathEnc}
 *    &recursionLevel=Full&api-version=7.1` to list every item under the
 *    scope path in one JSON RTT, filters to entries with
 *    `gitObjectType === "blob"`, then fans out parallel single-file
 *    fetches against the Items API for each blob's `path`. Bounded
 *    worker pool exactly mirrors `GitHubFetcher.fetchTreeViaBlobs`
 *    (stable order, clean error short-circuit).
 *
 *    When the listing returns an empty `value` array (NOT a 404 — ADO
 *    signals "this scope path is not a directory" with an empty value
 *    rather than an HTTP error), the fetcher falls back to a single-
 *    file fetch of `subPath` and yields it under its basename. This
 *    mirrors the single-file subpath branch in `GitHubFetcher` so
 *    consumers see the same `relPath` regardless of which transport ran.
 *
 * **Auth**: optional. The token is resolved via {@link resolveDefaultAdoToken}
 * which checks `AZURE_DEVOPS_EXT_PAT` → `AZURE_DEVOPS_PAT` →
 * `SYSTEM_ACCESSTOKEN` env vars first and then falls back to
 * `git -c credential.useHttpPath=true credential fill` (cached per
 * `(org, repo)` for 60s). When a token is present it is wrapped in a
 * `Basic` header — `Authorization: Basic base64(":" + token)`. **ALWAYS
 * Basic, never Bearer**: ADO's REST API accepts both PATs and Azure AD
 * JWTs through the same Basic-auth header (with an empty username),
 * which avoids needing to detect the token type at the auth layer.
 *
 * **No ref pinning**: the origin grammar deliberately rejects `&version=`,
 * so every install reads from the repo's default branch at the time of
 * the request. See `origin.ts` and the design doc for the trade-off
 * (ADO's GB / GT / GC ref-prefix grammar isn't modelled here).
 *
 * **50 MB per-file cap**: enforced for any individual blob, matching the
 * GitHub fetcher.
 */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Bound on concurrent Items API requests per `fetchTree` call. ADO doesn't
 * publish a hard per-second throttle but bounded fan-out keeps tail
 * latency tight on small skills (~5-30 files: 1-4 batches) and avoids
 * pathological burst behaviour for large subtrees. Matches the
 * `TREE_BLOB_PARALLELISM` constant in `GitHubFetcher`.
 */
const TREE_ITEM_PARALLELISM = 8;

const API_VERSION = "7.1";
const ADO_HOST = "https://dev.azure.com";

export class AzureDevOpsFetcher implements Fetcher {
  readonly scheme = "azure-devops";

  async fetchFile(uri: string, relPath: string): Promise<Buffer> {
    const origin = parseOrigin(uri);
    if (origin.scheme !== "azure-devops") {
      throw new FetchError(uri, "AzureDevOpsFetcher only handles azure-devops URIs");
    }
    if (typeof relPath !== "string") {
      throw new FetchError(uri, "fetchFile relPath must be a string");
    }
    if (relPath.startsWith("/")) {
      throw new FetchError(uri, `fetchFile relPath must be relative, got "${relPath}"`);
    }
    const { org, project, repo, path: subPath } = origin;

    // Compose the target path. ADO's `path=` query parameter expects a
    // repo-root-relative path WITH the leading slash, URL-encoded as a
    // single value (so `/skills/x/SKILL.md` becomes `%2Fskills%2Fx%2FSKILL.md`).
    //
    //  - relPath === "" → origin already names the file (mcp single-file
    //    case); use subPath as-is.
    //  - relPath !== "" → join subPath + relPath. subPath always starts
    //    with `/` (parser guarantees it); strip trailing slashes from
    //    subPath and leading slashes from relPath before joining.
    let targetPath: string;
    if (relPath === "") {
      targetPath = subPath;
    } else {
      const subTrimmed = subPath.replace(/\/+$/, "");
      const relTrimmed = relPath.replace(/^\/+/, "");
      targetPath = `${subTrimmed}/${relTrimmed}`;
    }
    return this.fetchItemRaw(uri, org, project, repo, targetPath);
  }

  async *fetchTree(uri: string): AsyncIterable<EntryFile> {
    const origin = parseOrigin(uri);
    if (origin.scheme !== "azure-devops") {
      throw new FetchError(uri, "AzureDevOpsFetcher only handles azure-devops URIs");
    }
    const { org, project, repo, path: subPath } = origin;

    const listing = await this.listTreeAt(uri, org, project, repo, subPath);

    // Empty listing → ADO treats `scopePath` as a single file rather
    // than a directory. Fall back to a direct file fetch and yield as
    // basename, matching `GitHubFetcher`'s single-file subpath branch.
    if (listing.length === 0) {
      const content = await this.fetchItemRaw(uri, org, project, repo, subPath);
      const slashIdx = subPath.lastIndexOf("/");
      const basename = slashIdx >= 0 ? subPath.slice(slashIdx + 1) : subPath;
      yield { relPath: basename, content };
      return;
    }

    // Filter blobs under subPath, mirroring `GitHubFetcher.fetchTreeViaBlobs`.
    const subPrefix = subPath.replace(/\/+$/, "");
    const planned: { adoPath: string; relPath: string }[] = [];
    for (const entry of listing) {
      if (entry.gitObjectType !== "blob") continue;
      const p = entry.path;
      if (p === subPrefix) {
        const slashIdx = subPrefix.lastIndexOf("/");
        const basename = slashIdx >= 0 ? subPrefix.slice(slashIdx + 1) : subPrefix;
        planned.push({ adoPath: p, relPath: basename });
      } else if (p.startsWith(`${subPrefix}/`)) {
        planned.push({ adoPath: p, relPath: p.slice(subPrefix.length + 1) });
      }
    }
    if (planned.length === 0) {
      throw new FetchError(uri, `subpath "${subPath}" matched no blobs in the tree`);
    }

    // Bounded worker pool — collect-then-yield for stable order and clean
    // error short-circuit. Mirrors `GitHubFetcher.fetchTreeViaBlobs`.
    const results: EntryFile[] = new Array(planned.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = cursor++;
        if (i >= planned.length) return;
        const job = planned[i];
        if (job === undefined) return;
        const content = await this.fetchItemRaw(uri, org, project, repo, job.adoPath);
        results[i] = { relPath: job.relPath, content };
      }
    };
    const workerCount = Math.min(TREE_ITEM_PARALLELISM, planned.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);

    for (const file of results) yield file;
  }

  /**
   * `GET /_apis/git/repositories/{repo}/items?scopePath={enc}&recursionLevel=Full&api-version=7.1`
   * returns `{ value: [{ path, gitObjectType, objectId, ... }, ...] }`. We
   * keep only the fields we use. Empty `value` is a real ADO response (it
   * signals "scopePath is not a directory" rather than throwing 404) and
   * is propagated to the caller as `[]` for the single-file fallback.
   */
  private async listTreeAt(
    uri: string,
    org: string,
    project: string,
    repo: string,
    scopePath: string,
  ): Promise<TreeItem[]> {
    const url = this.itemsUrl(org, project, repo, [
      ["scopePath", scopePath],
      ["recursionLevel", "Full"],
      ["api-version", API_VERSION],
    ]);
    const headers = await this.buildHeaders("application/json", org, repo);

    let response: Response;
    try {
      response = await fetch(url, { headers, redirect: "follow" });
    } catch (cause) {
      throw new FetchError(uri, `network error fetching tree: ${(cause as Error).message}`, {
        cause,
      });
    }
    if (!response.ok) {
      // Drain body so the socket can be released. Status line is safe
      // (no token leakage); the body is NOT surfaced because ADO error
      // payloads have historically echoed request headers in some
      // failure modes.
      try {
        await response.text();
      } catch {}
      throw new FetchError(
        uri,
        `Azure DevOps Items API returned ${response.status} ${response.statusText} for tree listing of "${scopePath}"`,
      );
    }
    let json: { value?: ReadonlyArray<{ path?: unknown; gitObjectType?: unknown }> };
    try {
      json = (await response.json()) as typeof json;
    } catch (cause) {
      throw new FetchError(
        uri,
        `Items API tree response was not valid JSON: ${(cause as Error).message}`,
        { cause },
      );
    }
    const items: TreeItem[] = [];
    if (Array.isArray(json.value)) {
      for (const e of json.value) {
        if (
          e !== null &&
          typeof e === "object" &&
          typeof e.path === "string" &&
          typeof e.gitObjectType === "string"
        ) {
          items.push({ path: e.path, gitObjectType: e.gitObjectType });
        }
      }
    }
    return items;
  }

  /**
   * `GET /_apis/git/repositories/{repo}/items?path={enc}&api-version=7.1`
   * with `Accept: application/octet-stream` returns the raw file bytes.
   * Same leak-guard pattern as {@link listTreeAt}: the response body is
   * never surfaced in the error message.
   */
  private async fetchItemRaw(
    uri: string,
    org: string,
    project: string,
    repo: string,
    path: string,
  ): Promise<Buffer> {
    const url = this.itemsUrl(org, project, repo, [
      ["path", path],
      ["api-version", API_VERSION],
    ]);
    const headers = await this.buildHeaders("application/octet-stream", org, repo);

    let response: Response;
    try {
      response = await fetch(url, { headers, redirect: "follow" });
    } catch (cause) {
      throw new FetchError(uri, `network error fetching item: ${(cause as Error).message}`, {
        cause,
      });
    }
    if (!response.ok) {
      try {
        await response.text();
      } catch {}
      throw new FetchError(
        uri,
        `Azure DevOps Items API returned ${response.status} ${response.statusText} for ${path}`,
      );
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) {
      throw new FetchError(uri, `file exceeds ${MAX_FILE_BYTES}-byte cap`);
    }
    return buf;
  }

  /**
   * Compose an ADO Items API URL.
   *
   *  - `org` and `repo` are inserted verbatim — they are case-sensitive
   *    identifiers and the parser already extracted them in their
   *    canonical (decoded) form.
   *  - `project` is `encodeURIComponent`-d because it may contain spaces
   *    (e.g. `O365 Core` → `O365%20Core`).
   *  - Each query value is `encodeURIComponent`-d. This intentionally
   *    encodes the leading `/` of `path=`/`scopePath=` values as `%2F`:
   *    the Items API expects the full path including the leading slash,
   *    URL-encoded as a single query-value blob.
   */
  private itemsUrl(
    org: string,
    project: string,
    repo: string,
    query: ReadonlyArray<readonly [string, string]>,
  ): string {
    const encProject = encodeURIComponent(project);
    const qs = query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    return `${ADO_HOST}/${org}/${encProject}/_apis/git/repositories/${repo}/items?${qs}`;
  }

  /**
   * Build the standard request headers used across every Items API call.
   *
   * `Authorization: Basic base64(":" + token)` works for both PATs and
   * Azure AD JWTs — ADO accepts the same Basic-with-empty-username form
   * for both, so the auth layer doesn't need to detect token type.
   *
   * NOTE: `az` CLI fallback for token resolution is deliberately deferred
   * to a follow-up PR. The current chain (env → `git credential fill`)
   * covers CI pipelines and any developer with Git Credential Manager
   * configured, which is the dominant case for Microsoft-internal ADO
   * workflows.
   */
  private async buildHeaders(
    accept: string,
    org: string,
    repo: string,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "User-Agent": "emploke-catalog",
      Accept: accept,
    };
    const token = await resolveDefaultAdoToken(org, repo);
    if (token) {
      const b64 = Buffer.from(`:${token}`, "utf8").toString("base64");
      headers.Authorization = `Basic ${b64}`;
    }
    return headers;
  }
}

/** One entry of an Items API recursive listing, normalised to the two
 *  fields we use (`path` is repo-root-relative with leading `/`;
 *  `gitObjectType` is `"blob"` for files and `"tree"` for directories). */
interface TreeItem {
  readonly path: string;
  readonly gitObjectType: string;
}
