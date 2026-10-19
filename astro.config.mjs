import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://mizukioyama.github.io',
  base: '/blog',
  output: 'static',
  trailingSlash: 'always',
  integrations: [{
    name: 'blog-private-draft-mode',
    hooks: {
      'astro:config:setup': ({ command }) => {
        // Astro's command is authoritative: inherited shell flags must not enable
        // private drafts during builds, while local dev keeps its review preview.
        process.env.BLOG_LOAD_LOCAL_DRAFTS = command === 'dev' ? '1' : '0';
        process.env.BLOG_PRODUCTION_BUILD = command === 'build' ? '1' : '0';
        if (command === 'build') process.env.NODE_ENV = 'production';
      },
    },
  }],
});
