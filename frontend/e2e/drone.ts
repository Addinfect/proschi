import lz from 'lz-string';
import { DRONE_TEAM_FILES, droneOrgSource } from '../src/playground/droneStartup';

/**
 * The editor on the drone startup (src/playground/droneStartup.ts): a share
 * link (src/playground/share.ts) with the org diagram and its team files as
 * the link's imports, the way the browser resolves `from`.
 */
export const droneLink = (buyRps = 100) =>
  `app/#code=${lz.compressToEncodedURIComponent(droneOrgSource(buyRps))}&imports=${lz.compressToEncodedURIComponent(JSON.stringify(DRONE_TEAM_FILES))}`;
