import antfu from '@antfu/eslint-config'

export default antfu().append(
  {
    files: ['test/**/*.test.ts'],
    rules: {
      'no-console': 'off',
      'test/no-import-node-test': 'off',
    },
  },
)
