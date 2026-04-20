'use strict';

const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.mjs'],
    exclude: ['node_modules', 'dist', '.railway'],
    testTimeout: 10000,
    setupFiles: ['./__tests__/setup.js'],
  },
});
