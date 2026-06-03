# Changelog

## Unreleased

### Removed

- `MetadataPatchBody` type alias (unused; 0 callers across monorepo). Use `Record<string, unknown>` inline if a body type is needed. Closes #283.
