/**
 * True when this page is open on a phone (or any other device) over the home
 * network, rather than in the app window on the PC. A phone watches and
 * follows; it does not change the PC's stations or settings.
 */
export const isRemote =
  typeof location !== "undefined" && !["127.0.0.1", "localhost", "[::1]", "::1"].includes(location.hostname);
