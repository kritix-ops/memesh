import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Admin client for the editable-content overrides. The registry metadata
// (labels, defaults, groups) is bundled from @memesh/content; the API only
// carries the values Yanay has changed. Mirrors apps/api/src/routes/content.ts.

export interface ContentOverridesResponse {
  /** key → override value, for the keys that have been customised. */
  overrides: Record<string, string>;
}

export interface ContentUpdateResponse {
  changed: string[];
}

export const getContentOverrides = (): Promise<ApiResult<ContentOverridesResponse>> =>
  apiRequest('/admin/content');

/** A blank value for a key resets it to the registry default (server deletes the row). */
export const updateContent = (
  patch: Record<string, string>,
): Promise<ApiResult<ContentUpdateResponse>> =>
  apiRequest('/admin/content', { method: 'PATCH', body: { patch } });
