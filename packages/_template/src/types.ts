/**
 * Public DTOs and option shapes for `@emploke/__PKG__`. Internal row
 * shapes live on `schema.ts`; this file is what HTTP routes and CLI
 * commands consume.
 */

/** Wire-shape projection of an `__Entity__`. */
export interface __Entity__ {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** Args accepted by `__Entity__Service.create`. */
export interface Create__Entity__Args {
  readonly name: string;
}

/** Filter options accepted by `__Entity__Queries.list`. */
export interface List__Entity__Opts {
  readonly nameStartsWith?: string;
}
