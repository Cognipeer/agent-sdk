/**
 * The SDK's version, for `telemetry.sdk.version` and the OTLP scope version.
 * Kept in a module of its own because the package is bundled (there is no
 * package.json to read at run time); a unit test fails when it drifts from
 * package.json, so a release bump cannot forget it.
 */
export const SDK_VERSION = "0.19.0";
