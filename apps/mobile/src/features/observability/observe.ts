import Constants from "expo-constants";
import { Observe } from "expo-observe";

// Importing expo-observe installs its global JS error handler; reports leave only through the relay.
const relayUrl: unknown = Constants.expoConfig?.extra?.relay?.url;
const observabilityEnabled: unknown = Constants.expoConfig?.extra?.observability?.enabled;
const appVariant: unknown = Constants.expoConfig?.extra?.appVariant;

export const crashReportingAvailable =
  observabilityEnabled === true && typeof relayUrl === "string" && relayUrl.trim() !== "";

interface PromiseRejectionTracker {
  readonly enablePromiseRejectionTracker?: (options: {
    readonly allRejections: boolean;
    readonly onUnhandled: (id: number, rejection: unknown) => void;
  }) => void;
}

// React Native tracks unhandled rejections only in development, for LogBox; Observe has no hook.
if (!__DEV__) {
  const hermes: PromiseRejectionTracker | undefined = Reflect.get(globalThis, "HermesInternal");
  hermes?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id, rejection) => Observe.reportError(rejection),
  });
}

let latestConfiguration = 0;

function applyObserveConfig(dispatchingEnabled: boolean) {
  Observe.configure({
    dispatchingEnabled,
    ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
  });
}

// While sending is off, a dispatch pass drops what it finds, so interactive opt-in runs one before enabling.
export async function setCrashReportsEnabled(enabled: boolean) {
  const configuration = ++latestConfiguration;
  const dispatchingEnabled = crashReportingAvailable && enabled;
  if (dispatchingEnabled) {
    await Observe.dispatchEvents();
    if (configuration !== latestConfiguration) return;
  }
  applyObserveConfig(dispatchingEnabled);
}

// Default-off without calling dispatchEvents() so previously persisted crash logs are not skipped before preferences load.
applyObserveConfig(false);

if (crashReportingAvailable) {
  const changedSinceLoad = () => latestConfiguration > 0;
  void import("../../persistence/imperative")
    .then(({ loadPreferences }) => loadPreferences())
    .then(
      (preferences) => {
        if (changedSinceLoad()) return;
        applyObserveConfig(preferences.crashReportsEnabled === true);
      },
      (error: unknown) => {
        console.warn("[observe] could not read the crash report setting", error);
        if (!changedSinceLoad()) applyObserveConfig(false);
      },
    )
    .catch((error: unknown) => {
      console.warn("[observe] could not apply the crash report setting", error);
    });
}
