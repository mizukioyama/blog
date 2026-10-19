import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import {
  createPrivateDraftAssetPlugin,
  privateDraftMarkdownImages,
} from './src/lib/private-draft-assets.mjs';

export default defineConfig({
  site: 'https://mizukioyama.github.io',
  base: '/blog',
  output: 'static',
  trailingSlash: 'always',
  integrations: [{
    name: 'blog-private-draft-mode',
    hooks: {
      'astro:config:setup': ({ command, config, updateConfig }) => {
        // Astro's command is authoritative: inherited shell flags must not enable
        // private drafts during builds, while local dev keeps its review preview.
        process.env.BLOG_LOAD_LOCAL_DRAFTS = command === 'dev' ? '1' : '0';
        process.env.BLOG_PRODUCTION_BUILD = command === 'build' ? '1' : '0';
        if (command === 'build') process.env.NODE_ENV = 'production';
        if (command === 'dev') {
          const root = fileURLToPath(config.root);
          updateConfig({
            server: { host: '127.0.0.1' },
            markdown: { processor: satteri({ mdastPlugins: [privateDraftMarkdownImages({ root })] }) },
            vite: { plugins: [createPrivateDraftAssetPlugin({ root })] },
          });
        }
      },
    },
  }],
});
