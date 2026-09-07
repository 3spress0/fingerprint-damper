/* Build only extension/runtime material. Browser fixtures and Node regression tests
 * stay in the source checkout; they must not ship inside the installable archive. */
module.exports = {
  artifactsDir: 'package',
  ignoreFiles: ['test/**', 'web-ext-config.cjs']
};
