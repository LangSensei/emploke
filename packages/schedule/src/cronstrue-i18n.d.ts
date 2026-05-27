/**
 * Ambient declaration for `cronstrue/i18n.js`. The cronstrue package
 * ships subpath entries (`i18n.js`, `i18n.d.ts`) at its root but
 * does NOT declare them in an `exports` field, so TypeScript's
 * NodeNext resolver can't find them automatically.
 *
 * Both type AND runtime resolution need the explicit `.js` extension
 * under NodeNext ESM: the legacy "subpath-without-exports" fallback
 * only applies to CommonJS / `node` module-resolution modes. The
 * import in `cron.ts` is correspondingly written as
 * `import cronstrue from "cronstrue/i18n.js"`.
 */
declare module "cronstrue/i18n.js" {
  interface CronstrueOptions {
    readonly locale?: string;
    readonly use24HourTimeFormat?: boolean;
    readonly verbose?: boolean;
    readonly dayOfWeekStartIndexZero?: boolean;
    readonly monthStartIndexZero?: boolean;
    readonly throwExceptionOnParseError?: boolean;
  }
  const cronstrue: {
    toString(expression: string, options?: CronstrueOptions): string;
  };
  export default cronstrue;
}
