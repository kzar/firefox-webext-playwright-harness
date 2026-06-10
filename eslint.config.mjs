import ddgConfig from '@duckduckgo/eslint-config';
import globals from 'globals';

export default [
    { ignores: ['node_modules/', 'tests/'] },

    ...ddgConfig,

    {
        files: ['src/**/*.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.webextensions,
                ...globals.browser,
            },
        },
    },
];
