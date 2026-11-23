import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/account', '/admin', '/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/auth/', '/design-system', '/api/'] }],
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}
