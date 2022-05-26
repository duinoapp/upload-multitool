module.exports = {
  root: true,
  extends: ['eslint:recommended', 'airbnb-base'],
  plugins: ['import'],
  parserOptions: {
    project: './tsconfig.eslint.json',
  },
};