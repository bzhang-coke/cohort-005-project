import {
  definePlugin,
  defineRule,
  type Context,
  type ESTree,
  type Scope,
} from "@oxlint/plugins";

type Node = ESTree.Node;

function unwrap(node: Node): Node {
  switch (node.type) {
    case "TSAsExpression":
    case "TSTypeAssertion":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSInstantiationExpression":
    case "ChainExpression":
    case "ParenthesizedExpression":
      return unwrap(node.expression);
    default:
      return node;
  }
}

function staticString(node: Node): string | undefined {
  const value = unwrap(node);
  if (value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (value.type === "TemplateLiteral" && value.expressions.length === 0) {
    return value.quasis[0].value.cooked ?? undefined;
  }
  return undefined;
}

function memberName(node: Node): string | undefined {
  if (node.type !== "MemberExpression") return undefined;
  return !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : staticString(node.property);
}

function drizzleImport(context: Context, node: Node) {
  if (node.type !== "Identifier") return undefined;
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) {
      const definition = variable.defs.find(
        (candidate) => candidate.type === "ImportBinding"
      );
      const declaration = definition?.parent;
      return declaration?.type === "ImportDeclaration" &&
        /^drizzle-orm(?:\/sql(?:\/sql)?)?$/.test(declaration.source.value)
        ? definition?.node
        : undefined;
    }
    scope = scope.upper;
  }
  return undefined;
}

function isDrizzleSql(context: Context, node: Node): boolean {
  const value = unwrap(node);
  const binding = drizzleImport(context, value);
  if (binding?.type === "ImportSpecifier") {
    return binding.imported.type === "Identifier"
      ? binding.imported.name === "sql"
      : binding.imported.value === "sql";
  }
  return (
    value.type === "MemberExpression" &&
    memberName(value) === "sql" &&
    drizzleImport(context, unwrap(value.object))?.type ===
      "ImportNamespaceSpecifier"
  );
}

// Literal-only by design: even const identifiers require data-flow analysis.
// Use Drizzle's parameterized helpers or sql tagged templates for values.
// API: https://oxc.rs/docs/guide/usage/linter/writing-js-plugins
export const noDynamicSqlRaw = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require literal strings in Drizzle sql.raw calls",
    },
    schema: [],
    messages: {
      dynamicSqlRaw:
        "sql.raw accepts only a string literal or a template literal without substitutions. Use a parameterized sql tagged template or Drizzle query helpers for dynamic values.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (
          callee.type !== "MemberExpression" ||
          memberName(callee) !== "raw" ||
          !isDrizzleSql(context, callee.object)
        ) {
          return;
        }
        const argument = node.arguments[0];
        if (!argument || staticString(argument) === undefined) {
          context.report({
            node: argument ?? node,
            messageId: "dynamicSqlRaw",
          });
        }
      },
    };
  },
});

// oxlint-disable-next-line import/no-default-export -- Oxlint loads plugins through their default export.
export default definePlugin({
  meta: { name: "cadence" },
  rules: { "no-dynamic-sql-raw": noDynamicSqlRaw },
});
