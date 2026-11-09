/** `routeTag` 10086 becomes `_cradle_hostname=g10086`. A value that already starts with `g` is kept. */
export function cradleHostname(routeTag: string | undefined): string | undefined {
  const value = routeTag?.trim();
  if (!value) return undefined;
  return value.startsWith("g") ? value : `g${value}`;
}

/** Append the dynamic-env tag to any Weixin API URL when `routeTag` is configured. */
export function appendCradleHostname(url: URL, routeTag: string | undefined): void {
  const cradle = cradleHostname(routeTag);
  if (!cradle) return;
  url.searchParams.set("_cradle_hostname", cradle);
}
