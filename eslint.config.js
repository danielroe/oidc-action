import antfu from '@antfu/eslint-config'

export default antfu().append({
  rules: {
    'test/no-import-node-test': 'off',
  },
})
