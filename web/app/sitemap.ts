import type { MetadataRoute } from 'next';
import { siteOrigin } from '../../src/identity/site.ts';
export const dynamic = 'force-static';
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: siteOrigin() }];
}
