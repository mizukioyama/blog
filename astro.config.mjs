import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://mizukioyama.github.io',
  base: '/blog',
  output: 'static',
  trailingSlash: 'always',
});
