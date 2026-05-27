/**
 * Ambient declaration for `cronstrue/i18n`. The cronstrue package
 * ships subpath entries (`i18n.js`, `i18n.d.ts`) at its root but
 * does NOT declare them in an `exports` field, so TypeScript's
 * NodeNext resolver can't find them automatically.
 *
 * The Node runtime resolves `cronstrue/i18n` fine (subpath-without-
 * exports is the legacy fallback); only the type lookup needs help.
 */
declare module "cronstrue/i18n" {
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
