import { describe, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import { noDynamicSqlRaw } from "./oxlint-plugin";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

const sqlImport = 'import { sql } from "drizzle-orm";';

tester.run("no-dynamic-sql-raw", noDynamicSqlRaw, {
  valid: [
    `${sqlImport} sql.raw("count(*)");`,
    `${sqlImport} sql.raw('');`,
    `${sqlImport} sql.raw(\`count(*)\`);`,
    `${sqlImport} sql.raw(\`\`);`,
    `${sqlImport} sql.raw("count(*)" as const);`,
    `${sqlImport} sql.raw(("count(*)" satisfies string)!);`,
    `${sqlImport} sql.raw(<string>"count(*)");`,
    `${sqlImport} sql["raw"]("count(*)");`,
    `${sqlImport} sql\`title = \${input}\`;`,
    `${sqlImport} sql.identifier(input);`,
    `${sqlImport} other.raw(input);`,
    `${sqlImport} function unrelated(sql) { sql.raw(input); }`,
    'import { sql } from "another-library"; sql.raw(input);',
    "const sql = { raw(value) { return value; } }; sql.raw(input);",
    'import { sql as query } from "drizzle-orm"; query.raw("count(*)");',
    'import * as orm from "drizzle-orm"; orm.sql.raw(`count(*)`);',
    'import * as orm from "another-library"; orm.sql.raw(input);',
    'import * as orm from "drizzle-orm"; function unrelated(orm) { orm.sql.raw(input); }',
  ],
  invalid: [
    ...[
      // The original course search vulnerability.
      "sql.raw(`(title LIKE '%${search}%' OR description LIKE '%${search}%')`);",
      "sql.raw(input);",
      'sql.raw("title = " + input);',
      "sql.raw(buildQuery());",
      'sql.raw(flag ? "ASC" : "DESC");',
      "sql.raw(...args);",
      'const fragment = "count(*)"; sql.raw(fragment);',
      "sql.raw(input as string);",
      "sql.raw(input satisfies string);",
      "sql.raw(input!);",
      "(sql.raw)(input);",
      "(sql.raw!)(input);",
      "sql!.raw(input);",
      "(sql as typeof sql).raw(input);",
      'sql["raw"](input);',
      "sql[`raw`](input);",
      "sql?.raw(input);",
      "sql.raw?.(input);",
      "sql.raw(42);",
      "sql.raw();",
    ].map((code) => ({
      code: `${sqlImport} ${code}`,
      errors: [{ messageId: "dynamicSqlRaw" }],
    })),
    ...[
      'import { sql as query } from "drizzle-orm"; query.raw(input);',
      'import { sql } from "drizzle-orm/sql"; sql.raw(input);',
      'import { sql } from "drizzle-orm/sql/sql"; sql.raw(input);',
      'import * as orm from "drizzle-orm"; orm.sql.raw(input);',
      'import * as orm from "drizzle-orm"; orm["sql"]["raw"](input);',
      'import { sql } from "drizzle-orm"; function search() { return sql.raw(input); }',
      'import { sql as query } from "drizzle-orm"; function search(sql) { return query.raw(input); }',
    ].map((code) => ({
      code,
      errors: [{ messageId: "dynamicSqlRaw" }],
    })),
  ],
});
