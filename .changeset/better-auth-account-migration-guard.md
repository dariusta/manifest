---
'manifest': patch
---

Let a fresh install boot: the two `account.issuer` migrations no longer assume Better Auth's table exists

`account` is created by Better Auth's own migration run, which is not ordered
against the TypeORM chain. Because TypeORM migrations run first at boot
(`migrationsRun`), a pristine database reached
`AddBetterAuthAccountIssuer`/`RelaxAccountIssuerNullable` before the table
existed and the whole chain aborted with `relation "account" does not exist` —
so a brand-new deployment could never finish migrating. Both migrations now
probe `information_schema` and skip when the table is absent, which is the
correct behaviour anyway: they exist to backfill a *populated* Better Auth 1.6
table, and 1.7 creates `issuer` itself. Populated databases are unaffected.
