export default {
  '*.{js,mjs,cjs,ts,tsx,vue}': [
    'eslint --fix --fix-type problem --max-warnings=0 --no-warn-ignored',
    'prettier --write',
    'eslint --max-warnings=0 --no-warn-ignored',
  ],
  '*.{json,jsonc,css,html,md,yaml,yml}': 'prettier --write',
};
