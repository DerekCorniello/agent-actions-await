import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        files: ["**/*.ts"],
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unnecessary-condition": "off",
            "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
            "@typescript-eslint/consistent-type-definitions": "off",
            "@typescript-eslint/dot-notation": "off",
            "@typescript-eslint/no-empty-function": "off",
            "@typescript-eslint/array-type": "off",
            "@typescript-eslint/restrict-template-expressions": "off",
            "@typescript-eslint/require-await": "off",
            "@typescript-eslint/no-deprecated": "off",
            "@typescript-eslint/no-confusing-void-expression": "off",
            "@typescript-eslint/no-floating-promises": "off",
            "@typescript-eslint/no-misused-promises": "off",
            "@typescript-eslint/no-base-to-string": "off",
            "@typescript-eslint/prefer-regexp-exec": "off",
            "@typescript-eslint/naming-convention": "off",
            "@typescript-eslint/no-unnecessary-type-assertion": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unnecessary-type-conversion": "off",
            "@typescript-eslint/prefer-optional-chain": "off",
            "@typescript-eslint/no-redundant-type-constituents": "off",
            "no-console": "off",
            "no-empty": "off",
        },
    },
    {
        files: ["tests/**/*.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/consistent-type-imports": "off",
            "@typescript-eslint/unbound-method": "off",
            "prefer-const": "off",
        },
    },
    {
        files: ["**/*.ts", "**/*.js", "**/*.mjs"],
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ["vitest.config.ts"],
                },
            },
        },
    },
    {
        files: ["eslint.config.mjs", "scripts/postinstall.js"],
        extends: [tseslint.configs.disableTypeChecked],
        languageOptions: {
            parserOptions: {
                projectService: false,
            },
        },
        rules: {
            "@typescript-eslint/no-unused-vars": "off",
            "no-undef": "off",
            "no-empty": "off",
        },
    },
    {
        ignores: ["dist/**", "coverage/**", "node_modules/**"],
    },
    prettier,
);
