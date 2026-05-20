import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema for the workspace pkg's global registry DB,
 * post-ADR-3 (issue #139). Replaces the v0->v1 / v1->v2 chain that
 * lived under the deleted custom migration framework.
 */
export class Migration00000000000000_initial extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'CREATE TABLE "workspaces" (' +
        '"id" uuid NOT NULL, ' +
        '"workspace_dir" text NOT NULL, ' +
        '"name" text NOT NULL, ' +
        '"created_at" text NOT NULL, ' +
        'PRIMARY KEY ("id"), ' +
        'CONSTRAINT "workspaces_workspace_dir_unique" UNIQUE ("workspace_dir")' +
        ");",
    );
    this.addSql(
      'CREATE TABLE "global_state" (' +
        '"key" text NOT NULL, ' +
        '"value" text NOT NULL, ' +
        'PRIMARY KEY ("key")' +
        ");",
    );
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE "global_state";');
    this.addSql('DROP TABLE "workspaces";');
  }
}
