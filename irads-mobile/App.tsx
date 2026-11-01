import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  ActivityIndicator,
  AppState,
  Alert,
  Modal,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  Vibration,
  View,
  Platform,
} from "react-native";

import {
  checkSpeedGate,
  startRoadSensorCollection,
  SENSOR_WINDOW_SIZE,
  MAX_GPS_ACCURACY_METERS,
} from "./sensors/roadSensor";
import * as Location from "expo-location";
import * as Speech from "expo-speech";
import IRADSMap from "./IRADSMap";
import { AIService } from "./src/ai/aiService";
import type { SensorReading } from "./src/sensors/types";
import { API_BASE_URL } from "./src/config";
import { syncService } from "./src/storage/syncService";
import { getDeviceIdHash } from "./src/storage/deviceIdentity";

// The platform-specific map can accept newer optional props while the native
// map implementation is updated separately. Expo Web resolves IRADSMap.web.tsx.
const IRADSMapWithDestination = IRADSMap as React.ComponentType<any>;

// ============================================================
// TYPES
// ============================================================

type Coordinate = {
  latitude: number;
  longitude: number;
};

type LiveGPSFix = Coordinate & {
  accuracyM: number | null;
  speedKmh: number | null;
  timestamp: number;
};

type DestinationResult = {
  id: string;
  name: string;
  address: string;
  coordinate: Coordinate;
};

type Hazard = Coordinate & {
  id: string;
  intensity: number;
  type: "POTHOLE" | "SPEED_BREAKER";
  confidence: number;
};

type NearbyAnomaliesResponse = {
  count: number;
  radius_m: number;
  anomalies: Array<{
    id: string;
    type: "POTHOLE" | "SPEED_BREAKER";
    confidence: number;
    confidence_avg?: number;
    latitude: number;
    longitude: number;
    gps_accuracy_m?: number;
    speed_kmh?: number;
    detected_at?: string;
    created_at?: string;
    is_processed?: boolean;
  }>;
};

type RouteAnomaliesResponse = {
  count: number;
  corridor_m: number;
  anomalies: Array<{
    id: string;
    type: "POTHOLE" | "SPEED_BREAKER";
    severity: number;
    confidence: number | null;
    report_count: number;
    latitude: number;
    longitude: number;
    distance_to_route_m: number;
    last_seen: string | null;
  }>;
};

// ============================================================
// CONFIGURATION
// ============================================================

// Search radius for nearby road anomalies.
const SEARCH_RADIUS_METERS = 10000;

// Default map location: Bengaluru.
// This also lets you test against your existing Bengaluru data.
const INITIAL_LOCATION: Coordinate = {
  latitude: 12.9716,
  longitude: 77.5946,
};

// Estimate distance between two GPS coordinates in metres.
function distanceMeters(
  a: Coordinate,
  b: Coordinate,
): number {
  const earthRadiusMeters = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(Math.min(1, h)));
}


// Project a coordinate onto every route segment. Returns the closest distance
// to the route and distance travelled along the route to that projection.
function projectOntoRoute(
  point: Coordinate,
  route: Coordinate[],
): { distanceToRouteMeters: number; distanceAlongRouteMeters: number } | null {
  if (route.length < 2) return null;

  const earthRadiusMeters = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latScale = (Math.PI / 180) * earthRadiusMeters;
  const lonScale = latScale * Math.cos(toRadians(point.latitude));

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestAlong = 0;
  let distanceBeforeSegment = 0;

  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const ax = (a.longitude - point.longitude) * lonScale;
    const ay = (a.latitude - point.latitude) * latScale;
    const bx = (b.longitude - point.longitude) * lonScale;
    const by = (b.latitude - point.latitude) * latScale;
    const dx = bx - ax;
    const dy = by - ay;
    const segmentLengthSquared = dx * dx + dy * dy;
    const t = segmentLengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / segmentLengthSquared));
    const projectedX = ax + t * dx;
    const projectedY = ay + t * dy;
    const distance = Math.hypot(projectedX, projectedY);
    const segmentLength = Math.sqrt(segmentLengthSquared);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestAlong = distanceBeforeSegment + t * segmentLength;
    }
    distanceBeforeSegment += segmentLength;
  }

  return {
    distanceToRouteMeters: bestDistance,
    distanceAlongRouteMeters: bestAlong,
  };
}

// Keep reports very close to the blue route line to avoid alerting for nearby
// roads. A small tolerance is necessary because phone GPS and report locations
// are not perfectly accurate.
function calculateRouteLength(route: Coordinate[]): number {
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    total += distanceMeters(route[i - 1], route[i]);
  }
  return total;
}

// Testing only: allows TFLite inference at 0 km/h; never saves idle predictions.
const DIAGNOSTIC_BYPASS_SPEED_GATE = true;

const POTHOLE_ALERT_DISTANCE_METERS = 100;
const MAX_RIDER_ROUTE_OFFSET_METERS = 30;
const ROUTE_CORRIDOR_METERS = 15;
const ROUTE_PROGRESS_TOLERANCE_METERS = 10;
// Automatic rerouting: confirm real departure from a road before calling OSRM.
const REROUTE_OFFSET_METERS = 45;
const REROUTE_MIN_FIX_SEPARATION_MS = 3000;
const REROUTE_RETRY_INTERVAL_MS = 20000;
const REROUTE_MIN_SPEED_KMH = 3;
const REROUTE_MAX_GPS_AGE_MS = 10000;
const REROUTE_MAX_GPS_ACCURACY_METERS = 25;

// Draw only the untraveled part of the navigation route without altering
// the original route used for alerts, progress, and automatic rerouting.
function remainingRouteGeometry(route: Coordinate[], distanceAlongMeters: number): Coordinate[] {
  if (route.length < 2 || !Number.isFinite(distanceAlongMeters)) return route;
  let traveled = 0;
  for (let index = 0; index < route.length - 1; index++) {
    const segmentLength = distanceMeters(route[index], route[index + 1]);
    if (traveled + segmentLength >= distanceAlongMeters) {
      const ratio = segmentLength > 0
        ? Math.max(0, Math.min(1, (distanceAlongMeters - traveled) / segmentLength))
        : 0;
      const start = {
        latitude: route[index].latitude +
          (route[index + 1].latitude - route[index].latitude) * ratio,
        longitude: route[index].longitude +
          (route[index + 1].longitude - route[index].longitude) * ratio,
      };
      return [start, ...route.slice(index + 1)];
    }
    traveled += segmentLength;
  }
  return [route[route.length - 1]];
}

// ============================================================
// APP
// ============================================================

export default function App() {
  const [speedKmh, setSpeedKmh] = useState<number | null>(null);
  const [speedGateMessage, setSpeedGateMessage] = useState(
    "Waiting for GPS speed...",
  );
  const speedRef = useRef<number | null>(null);
  const latestGpsFixRef = useRef<LiveGPSFix | null>(null);
  const aiServiceRef = useRef<AIService | null>(null);
  const [aiStatus, setAiStatus] = useState("Initializing on-device model...");
  const [modelInitStatus, setModelInitStatus] = useState<"waiting" | "loading" | "ready" | "error">("loading");
  // Diagnostic panel: sensor values are available without GPS (max ~4 UI updates/sec).
  const [liveSensors, setLiveSensors] = useState<{
    ax: number; ay: number; az: number;
    gx: number; gy: number; gz: number;
  } | null>(null);
  const lastSensorUiUpdateRef = useRef(0);


  // Diagnostic-only prediction banner: show every non-NORMAL classifier output,
  // regardless of confidence, GPS or speed. Does NOT change persistence.
  const [predictionBanner, setPredictionBanner] = useState<{
    type: "POTHOLE" | "SPEED_BREAKER";
    confidence: number;
    count: number;
  } | null>(null);
  const predictionCountRef = useRef(0);
  const predictionBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Testing notification for successfully saved anomaly detections.
  const [detectionToast, setDetectionToast] = useState<
    "POTHOLE" | "SPEED_BREAKER" | null
  >(null);
  const detectionToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousPositionRef = useRef<{
    latitude: number;
    longitude: number;
    timestamp: number;
    accuracy: number | null;
  } | null>(null);
  const [currentLocation, setCurrentLocation] =
    useState<Coordinate | null>(null);

  const [source, setSource] = useState("My location");
  const [selectedSourceCoordinate, setSelectedSourceCoordinate] = useState<Coordinate | null>(null);
  const [pendingMapCoordinate, setPendingMapCoordinate] = useState<Coordinate | null>(null);
  const [sourceResults, setSourceResults] = useState<DestinationResult[]>([]);
  const [destination, setDestination] = useState("");
  // Exact selected destination coordinate is rendered as a red map pin.
  const [selectedDestinationCoordinate, setSelectedDestinationCoordinate] =
    useState<Coordinate | null>(null);
  const [destinationResults, setDestinationResults] = useState<DestinationResult[]>([]);
  const [destinationSearchOpen, setDestinationSearchOpen] = useState(false);
  const [searchingDestination, setSearchingDestination] = useState(false);
  const [loadingRoute, setLoadingRoute] = useState(false);
  // Nearby places use OpenStreetMap Overpass data. No new API key is needed.
  const [nearbyCategory, setNearbyCategory] = useState<string | null>(null);
  const [nearbyPlaces, setNearbyPlaces] = useState<DestinationResult[]>([]);
  const [loadingNearby, setLoadingNearby] = useState(false);
  const nearbyRequestRef = useRef(0);


  const [routeCoordinates, setRouteCoordinates] = useState<Coordinate[]>([]);
  const [routeDistanceMeters, setRouteDistanceMeters] = useState<number | null>(null);
  const [routeDurationSeconds, setRouteDurationSeconds] = useState<number | null>(null);

  const [hazards, setHazards] = useState<Hazard[]>([]);
  const [nearbyConfirmedHazards, setNearbyConfirmedHazards] = useState<Hazard[]>([]);

  const [showHeatmap, setShowHeatmap] = useState(true);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [registeredDeviceId, setRegisteredDeviceId] = useState("");

  useEffect(() => {
    if (!settingsVisible || Platform.OS === "web") return;
    let active = true;
    void getDeviceIdHash()
      .then((id) => { if (active) setRegisteredDeviceId(id); })
      .catch(() => { if (active) setRegisteredDeviceId(""); });
    return () => { active = false; };
  }, [settingsVisible]);

  const [routeSelected, setRouteSelected] = useState(false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [navigationProgress, setNavigationProgress] = useState({
    completedMeters: 0,
    remainingMeters: 0,
    percentage: 0,
  });
  const [navigationOnRoute, setNavigationOnRoute] = useState(false);
  const [rerouteStatus, setRerouteStatus] = useState<string | null>(null);
  const rerouteInFlightRef = useRef(false);
  const rerouteLastAttemptRef = useRef(0);
  const offRouteFirstFixAtRef = useRef<number | null>(null);
  const offRouteFixCountRef = useRef(0);
  const rerouteSessionRef = useRef(0);
  const rerouteStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigationActiveRef = useRef(false);
  const destinationForRerouteRef = useRef<Coordinate | null>(null);

  function showRerouteStatus(message: string, clearAfterMs = 0) {
    if (rerouteStatusTimerRef.current !== null) clearTimeout(rerouteStatusTimerRef.current);
    setRerouteStatus(message);
    if (clearAfterMs > 0) {
      rerouteStatusTimerRef.current = setTimeout(() => {
        setRerouteStatus(null);
        rerouteStatusTimerRef.current = null;
      }, clearAfterMs);
    }
  }

  const alertedHazardsRef = useRef<Set<string>>(new Set());
  const [potholeAheadAlert, setPotholeAheadAlert] = useState<{
    distance: number;
    level: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  } | null>(null);
  const potholeAheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recenterRequest, setRecenterRequest] = useState(0);

  const [loadingLocation, setLoadingLocation] = useState(true);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const [loadingHazards, setLoadingHazards] = useState(false);

  const [hazardError, setHazardError] = useState<string | null>(null);
  // Prevent slower, older requests from overwriting results for a newer route.
  const hazardRequestIdRef = useRef(0);

  // Offline-first sync: pending SQLite events survive app restarts.
  // Retry when the app opens/returns to foreground and periodically while open,
  // so events are uploaded even if the backend starts after detection.
  useEffect(() => {
    if (Platform.OS === "web") return;

    let appIsActive = AppState.currentState === "active";

    const trySyncPendingEvents = (reason: string) => {
      if (!appIsActive) return;
      void syncService.syncPendingEvents().catch((error) => {
        console.warn(`[OFFLINE SYNC] Retry failed (${reason}):`, error);
      });
    };

    trySyncPendingEvents("app-start");

    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      appIsActive = nextState === "active";
      if (appIsActive) trySyncPendingEvents("app-foreground");
    });

    const retryInterval = setInterval(() => {
      if (AppState.currentState === "active") {
        trySyncPendingEvents("periodic-retry");
      }
    }, 15000);

    return () => {
      appIsActive = false;
      appStateSubscription.remove();
      clearInterval(retryInterval);
    };
  }, []);

  // ----------------------------------------------------------
  // LOCATION
  // ----------------------------------------------------------

  useEffect(() => {
    let mounted = true;
    let hasLiveFix = false;
    let locationSubscription: Location.LocationSubscription | null = null;
    let acquisitionTimer: ReturnType<typeof setTimeout> | null = null;

    async function startLocationTracking() {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (!mounted) return;
        if (status !== "granted") {
          console.warn("Location permission was not granted.");
          setLocationNotice("Enable location permission to get GPS updates.");
          setLoadingLocation(false);
          return;
        }

        // A short cached fix can center the map while waiting for live GPS.
        // Do not feed it to the sensor pipeline: it is not a live GPS fix.
        void Location.getLastKnownPositionAsync({
          maxAge: 60_000,
          requiredAccuracy: 100,
        }).then((cached) => {
          if (!mounted || hasLiveFix || !cached) return;
          if (!Number.isFinite(cached.coords.latitude) ||
              !Number.isFinite(cached.coords.longitude)) return;
          setCurrentLocation({
            latitude: cached.coords.latitude,
            longitude: cached.coords.longitude,
          });
          setLocationNotice("Showing recent position; waiting for live GPS.");
        }).catch((error) => {
          console.warn("Last-known location unavailable:", error);
        });

        // Start live updates immediately. Do NOT block on getCurrentPositionAsync:
        // initial satellite acquisition can fail or take longer offline.
        acquisitionTimer = setTimeout(() => {
          if (!mounted || hasLiveFix) return;
          setLoadingLocation(false);
          setLocationNotice("Waiting for GPS signal. Try an open outdoor area.");
        }, 20_000);

        const subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 5000,
            distanceInterval: 5,
          },
          (updatedLocation) => {
            if (!mounted) return;
            hasLiveFix = true;
            setLoadingLocation(false);
            setLocationNotice(null);

            const coordinate = {
              latitude: updatedLocation.coords.latitude,
              longitude: updatedLocation.coords.longitude,
            };

            const reportedSpeed = updatedLocation.coords.speed;
            let speedMetersPerSecond: number | null =
              reportedSpeed !== null &&
              Number.isFinite(reportedSpeed) &&
              reportedSpeed >= 0
                ? reportedSpeed
                : null;

            const previous = previousPositionRef.current;
            const currentAccuracy = updatedLocation.coords.accuracy;
            const elapsedSeconds = previous
              ? (updatedLocation.timestamp - previous.timestamp) / 1000
              : 0;

            let speedSource: "GPS" | "POSITION_ESTIMATE" | "UNAVAILABLE" =
              speedMetersPerSecond !== null ? "GPS" : "UNAVAILABLE";

            // Web geolocation often omits coords.speed. Estimate it only when
            // both fixes are reasonably accurate and the elapsed time is valid.
            if (
              speedMetersPerSecond === null &&
              Platform.OS === "web" &&
              previous &&
              previous.accuracy !== null &&
              currentAccuracy !== null &&
              previous.accuracy <= 30 &&
              currentAccuracy <= 30 &&
              elapsedSeconds >= 1 &&
              elapsedSeconds <= 15
            ) {
              const distance = distanceMeters(previous, coordinate);
              // Require movement to exceed likely GPS noise. If it does not,
              // keep speed unavailable instead of incorrectly assuming 0 km/h.
              const movementThreshold = Math.max(
                5,
                previous.accuracy,
                currentAccuracy,
              );

              if (distance > movementThreshold) {
                speedMetersPerSecond = distance / elapsedSeconds;
                speedSource = "POSITION_ESTIMATE";
              }
            }

            console.log("GPS DEBUG:", {
              platform: Platform.OS,
              latitude: coordinate.latitude,
              longitude: coordinate.longitude,
              reportedSpeedMetersPerSecond: reportedSpeed,
              accuracyMeters: currentAccuracy,
              elapsedSeconds,
              speedSource,
              estimatedOrReportedSpeedKmh:
                speedMetersPerSecond === null
                  ? null
                  : Number((speedMetersPerSecond * 3.6).toFixed(2)),
            });

            previousPositionRef.current = {
              latitude: coordinate.latitude,
              longitude: coordinate.longitude,
              timestamp: updatedLocation.timestamp,
              accuracy: currentAccuracy,
            };

            speedRef.current = speedMetersPerSecond;
            latestGpsFixRef.current = {
              ...coordinate,
              accuracyM: currentAccuracy,
              speedKmh:
                speedMetersPerSecond === null
                  ? null
                  : speedMetersPerSecond * 3.6,
              timestamp: updatedLocation.timestamp,
            };

            const gate = checkSpeedGate(speedMetersPerSecond);
            setSpeedKmh(gate.speedKmh);
            setSpeedGateMessage(gate.reason);

            setCurrentLocation(coordinate);

            console.log("Speed gate:", {
              allowed: gate.allowed,
              reason: gate.reason,
              speedKmh: gate.speedKmh,
            });
          }
        );
        if (!mounted) {
          subscription.remove();
          return;
        }
        locationSubscription = subscription;
      } catch (error) {
        console.error("Could not start location tracking:", error);
        if (mounted) {
          setLoadingLocation(false);
          setLocationNotice("GPS tracking unavailable. Check Location settings.");
        }
      }
    }

    void startLocationTracking();

    return () => {
      mounted = false;
      if (acquisitionTimer !== null) clearTimeout(acquisitionTimer);
      locationSubscription?.remove();
    };
  }, []);

  // ----------------------------------------------------------
  // GPS-INDEPENDENT DIAGNOSTIC INFERENCE
  // ----------------------------------------------------------

  // Model initialization and raw sensor collection run while this screen is
  // mounted, regardless of navigation or GPS quality. GPS and speed validation
  // still control whether an anomaly can be saved/uploaded.
  useEffect(() => {
    // react-native-fast-tflite requires a native development build.
    // Keep the browser map usable without trying to load the native runtime.
    if (Platform.OS === "web") {
      console.log("TFLite inference requires the Android/iOS development build.");
      setAiStatus("Web preview: route/map only. Run the Android build for TFLite inference.");
      return;
    }

    let active = true;
    let stopSensors: (() => void) | null = null;
    let lastSensorDebugLogAt = 0;

    async function startInferenceAndSensors() {
      try {
        setModelInitStatus("loading");
        setAiStatus("Loading on-device TFLite model...");
        console.log("Initializing IRADS TFLite model.");

        const service = aiServiceRef.current ?? new AIService();
        await service.initialize();

        if (!active) {
          service.reset();
          return;
        }

        aiServiceRef.current = service;
        setModelInitStatus("ready");

        service.onAnomalySaved = (type) => {
          if (!active) return;

          if (detectionToastTimerRef.current !== null) {
            clearTimeout(detectionToastTimerRef.current);
          }

          setDetectionToast(type);

          detectionToastTimerRef.current = setTimeout(() => {
            setDetectionToast(null);
            detectionToastTimerRef.current = null;
          }, 3000);
        };
        setAiStatus(
          `Model ready. TEST MODE: running inference while stationary; saving still requires valid GPS and speed.`,
        );
        console.log("IRADS TFLite model initialized.");

        stopSensors = startRoadSensorCollection((sample) => {
          // Temporary sensor diagnostic: log once per second even when the
          // speed gate rejects the sample, so sensor delivery can be verified
          // safely while the phone is stationary.
          const sensorDebugNow = Date.now();
          if (sensorDebugNow - lastSensorUiUpdateRef.current >= 250) {
            lastSensorUiUpdateRef.current = sensorDebugNow;
            setLiveSensors({
              ax: sample.ax, ay: sample.ay, az: sample.az,
              gx: sample.gx, gy: sample.gy, gz: sample.gz,
            });
          }
          if (sensorDebugNow - lastSensorDebugLogAt >= 1000) {
            console.log("IRADS RAW SENSOR DEBUG:", {
              timestamp: sample.timestamp,
              accelerometer: {
                x: sample.ax,
                y: sample.ay,
                z: sample.az,
              },
              gyroscope: {
                x: sample.gx,
                y: sample.gy,
                z: sample.gz,
              },
              speedKmh:
                speedRef.current === null
                  ? null
                  : Number((speedRef.current * 3.6).toFixed(2)),
            });
            lastSensorDebugLogAt = sensorDebugNow;
          }

          const gate = checkSpeedGate(speedRef.current);

          // Diagnostic mode: feed stationary samples to TFLite as well.
          // Normal speed gating can be restored by setting this flag to false.
          // When the gate is closed, GPS is deliberately omitted below so
          // stationary test predictions are never recorded as road hazards.
          if (!DIAGNOSTIC_BYPASS_SPEED_GATE && !gate.allowed) {
            return;
          }

          const fix = latestGpsFixRef.current;
          const gpsIsFresh =
            fix !== null &&
            Number.isFinite(fix.timestamp) &&
            Date.now() - fix.timestamp >= 0 &&
            Date.now() - fix.timestamp <= 10000;
          const gpsIsAccurate =
            fix !== null &&
            fix.accuracyM !== null &&
            Number.isFinite(fix.accuracyM) &&
            fix.accuracyM <= MAX_GPS_ACCURACY_METERS;
          const gpsHasSpeed =
            fix !== null &&
            fix.speedKmh !== null &&
            Number.isFinite(fix.speedKmh);

          const gps: SensorReading["gps"] =
            gate.allowed && fix && gpsIsFresh && gpsIsAccurate && gpsHasSpeed
              ? {
                  lat: fix.latitude,
                  lng: fix.longitude,
                  speedKmh: fix.speedKmh as number,
                  accuracyM: fix.accuracyM as number,
                  timestamp: fix.timestamp,
                }
              : null;

          const reading: SensorReading = {
            timestamp: sample.timestamp,
            // The collector runs at about 30 Hz. Its millisecond timestamps
            // are sufficient for the existing 100 ms window-gap guard.
            sensorTimestampMs: sample.timestamp,
            acc: {
              x: sample.ax,
              y: sample.ay,
              z: sample.az,
            },
            gyro: {
              x: sample.gx,
              y: sample.gy,
              z: sample.gz,
            },
            gps,
          };

          void service
            .processReading(reading)
            .then((prediction) => {
              if (!active || prediction === null) {
                return;
              }

              const percent = (prediction.confidence * 100).toFixed(1);
              console.log("IRADS TFLite prediction:", {
                type: prediction.type,
                confidence: prediction.confidence,
                gpsAttached: gps !== null,
              });

              // Display raw non-NORMAL classifications even when the backend's
              // 70% confidence threshold or GPS/speed gate prevents saving.
              if (prediction.type === "POTHOLE" || prediction.type === "SPEED_BREAKER") {
                predictionCountRef.current += 1;
                setPredictionBanner({
                  type: prediction.type,
                  confidence: prediction.confidence,
                  count: predictionCountRef.current,
                });
                if (predictionBannerTimerRef.current !== null) {
                  clearTimeout(predictionBannerTimerRef.current);
                }
                predictionBannerTimerRef.current = setTimeout(() => {
                  setPredictionBanner(null);
                  predictionBannerTimerRef.current = null;
                }, 1800);
              }

              if (prediction.type === "NORMAL") {
                setAiStatus(`Model: NORMAL (${percent}%).`);
              } else if (gps === null) {
                setAiStatus(
                  `TEST prediction: ${prediction.type} (${percent}%). Not saved (speed gate or GPS validation).`,
                );
              } else {
                setAiStatus(
                  `Model: ${prediction.type} (${percent}%). Checking confidence/cooldown and syncing eligible event.`,
                );
              }
            })
            .catch((error) => {
              if (!active) return;
              console.error("IRADS inference failed:", error);
              setAiStatus(
                `Inference error: ${
                  error instanceof Error ? error.message : "see console"
                }`,
              );
            });
        });

        console.log("Diagnostic inference active independently of GPS and navigation.");
      } catch (error) {
        if (!active) return;
        console.error("Could not initialize IRADS TFLite inference:", error);
        setModelInitStatus("error");
        setAiStatus(
          `Model initialization failed: ${
            error instanceof Error ? error.message : "see console"
          }`,
        );
      }
    }

    void startInferenceAndSensors();

    return () => {
      active = false;
      stopSensors?.();
      aiServiceRef.current?.reset();
      if (aiServiceRef.current) {
        aiServiceRef.current.onAnomalySaved = undefined;
      }
      if (predictionBannerTimerRef.current !== null) {
        clearTimeout(predictionBannerTimerRef.current);
        predictionBannerTimerRef.current = null;
      }
      if (detectionToastTimerRef.current !== null) {
        clearTimeout(detectionToastTimerRef.current);
        detectionToastTimerRef.current = null;
      }
      setDetectionToast(null);
      console.log("App unmounted: sensor collection disabled.");
    };
  }, []);

  // ----------------------------------------------------------
  // FETCH ANOMALIES FROM FASTAPI
  // ----------------------------------------------------------

  const fetchNearbyHazards = useCallback(
    async (location: Coordinate) => {
      const requestId = ++hazardRequestIdRef.current;
      setLoadingHazards(true);
      setHazardError(null);

      try {
        const params = new URLSearchParams({
          latitude: String(location.latitude),
          longitude: String(location.longitude),
          radius_m: String(SEARCH_RADIUS_METERS),
        });

        const url =
          `${API_BASE_URL}/api/v1/anomalies/nearby?` +
          params.toString();

        console.log("Fetching nearby road anomalies:", url);

        const response = await fetch(url, {
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          throw new Error(
            `Nearby-anomaly request failed with HTTP ${response.status}`,
          );
        }

        const data: NearbyAnomaliesResponse = await response.json();

        if (!Array.isArray(data.anomalies)) {
          throw new Error(
            "Unexpected nearby-anomaly response: anomalies must be an array.",
          );
        }

        const fetchedHazards: Hazard[] = data.anomalies
          .filter(
            (anomaly) =>
              Number.isFinite(Number(anomaly.latitude)) &&
              Number.isFinite(Number(anomaly.longitude)) &&
              Number.isFinite(Number(anomaly.confidence ?? anomaly.confidence_avg)) &&
              ["POTHOLE", "SPEED_BREAKER"].includes(anomaly.type),
          )
          .map((anomaly) => {
            const confidence = Math.max(
              0,
              Math.min(1, Number(anomaly.confidence ?? anomaly.confidence_avg)),
            );

            return {
              id: String(anomaly.id),
              latitude: Number(anomaly.latitude),
              longitude: Number(anomaly.longitude),
              type: anomaly.type,
              confidence,
              intensity: confidence,
            };
          });

        if (requestId !== hazardRequestIdRef.current) return;
        setNearbyConfirmedHazards(fetchedHazards);
        console.log(`Loaded ${fetchedHazards.length} nearby anomalies.`);
      } catch (error) {
        if (requestId !== hazardRequestIdRef.current) return;
        console.error("Failed to fetch nearby anomalies:", error);
        setHazardError("Anomaly data is temporarily unavailable. Route planning still works.");
        setNearbyConfirmedHazards([]);
      } finally {
        if (requestId === hazardRequestIdRef.current) {
          setLoadingHazards(false);
        }
      }
    },
    [],
  );

  // This endpoint reads active CONFIRMED anomalies and filters them against
  // the route geometry in PostGIS. Route coordinates must be [longitude, latitude].
  const fetchRouteHazards = useCallback(
    async (route: Coordinate[]) => {
      if (route.length < 2) {
        setHazards([]);
        return;
      }

      const requestId = ++hazardRequestIdRef.current;
      setLoadingHazards(true);
      setHazardError(null);

      try {
        const params = new URLSearchParams({
          corridor_m: String(ROUTE_CORRIDOR_METERS),
        });
        const url =
          `${API_BASE_URL}/api/v1/anomalies/along-route?${params.toString()}`;
        const routeCoordinates = route.map((point) => [
          point.longitude,
          point.latitude,
        ]);

        console.log("Fetching confirmed anomalies along selected route:", {
          url,
          coordinateCount: routeCoordinates.length,
          corridorMeters: ROUTE_CORRIDOR_METERS,
        });

        const response = await fetch(url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(routeCoordinates),
        });

        if (!response.ok) {
          const responseText = await response.text().catch(() => "");
          throw new Error(
            `Route-anomaly request failed with HTTP ${response.status}${responseText ? `: ${responseText}` : ""}`,
          );
        }

        const data: RouteAnomaliesResponse = await response.json();
        if (!Array.isArray(data.anomalies)) {
          throw new Error(
            "Unexpected route-anomaly response: anomalies must be an array.",
          );
        }

        const fetchedHazards: Hazard[] = data.anomalies
          .filter(
            (anomaly) =>
              Number.isFinite(Number(anomaly.latitude)) &&
              Number.isFinite(Number(anomaly.longitude)) &&
              ["POTHOLE", "SPEED_BREAKER"].includes(anomaly.type),
          )
          .map((anomaly) => {
            const confidenceValue = Number(anomaly.confidence);
            const confidence = Number.isFinite(confidenceValue)
              ? Math.max(0, Math.min(1, confidenceValue))
              : 0;

            return {
              id: String(anomaly.id),
              latitude: Number(anomaly.latitude),
              longitude: Number(anomaly.longitude),
              type: anomaly.type,
              confidence,
              intensity: confidence,
            };
          });

        if (requestId !== hazardRequestIdRef.current) return;
        setHazards(fetchedHazards);
        console.log(
          `Loaded ${fetchedHazards.length} confirmed anomalies along the selected route (API returned ${data.count}).`,
        );
      } catch (error) {
        if (requestId !== hazardRequestIdRef.current) return;
        console.error("Failed to fetch anomalies along selected route:", error);
        setHazardError("Anomaly data is temporarily unavailable. Route planning still works.");
        setHazards([]);
      } finally {
        if (requestId === hazardRequestIdRef.current) {
          setLoadingHazards(false);
        }
      }
    },
    [],
  );

  const lastNearbyFetchLocationRef = useRef<Coordinate | null>(null);

  // Before a route is selected, preserve the existing nearby-raw-report map.
  // While a route is selected, the separate effect below owns hazard fetching.
  useEffect(() => {
    if (routeSelected) {
      // The route-fetch effect owns requests while a route is selected. Do not
      // invalidate its response on every GPS position update.
      return;
    }

    if (!currentLocation) {
      hazardRequestIdRef.current += 1;
      setLoadingHazards(false);
      setHazards([]);
      setNearbyConfirmedHazards([]);
      setHazardError(
        loadingLocation
          ? null
          : "Location unavailable. Enable location access to find nearby anomalies.",
      );
      return;
    }

    const previous = lastNearbyFetchLocationRef.current;
    if (previous && distanceMeters(previous, currentLocation) < 150) return;
    lastNearbyFetchLocationRef.current = currentLocation;
    void fetchNearbyHazards(currentLocation);
  }, [currentLocation, loadingLocation, routeSelected, fetchNearbyHazards]);

  // Fetch route-specific, confirmed anomalies once for each selected route.
  // GPS updates do not trigger this effect, so moving does not repeatedly post
  // the full route to the backend.
  useEffect(() => {
    if (!routeSelected || routeCoordinates.length < 2) return;
    void fetchRouteHazards(routeCoordinates);
  }, [routeSelected, routeCoordinates, fetchRouteHazards]);

  // Recalculate the route when two separate high-quality GPS fixes confirm
  // the rider has left the displayed route. The model/sensor pipeline is unchanged.
  useEffect(() => {
    if (!isNavigating || !routeSelected || routeCoordinates.length < 2 ||
        !selectedDestinationCoordinate || !currentLocation) {
      offRouteFirstFixAtRef.current = null;
      offRouteFixCountRef.current = 0;
      return;
    }

    const fix = latestGpsFixRef.current;
    const now = Date.now();
    if (!fix || now - fix.timestamp > REROUTE_MAX_GPS_AGE_MS ||
        fix.accuracyM === null || fix.accuracyM > REROUTE_MAX_GPS_ACCURACY_METERS) {
      return;
    }
    // Slow or stationary GPS drift should not trigger a new route.
    if (fix.speedKmh !== null && fix.speedKmh < REROUTE_MIN_SPEED_KMH) {
      offRouteFirstFixAtRef.current = null;
      offRouteFixCountRef.current = 0;
      return;
    }
    const offset = projectOntoRoute(fix, routeCoordinates)?.distanceToRouteMeters;
    if (offset === undefined || offset <= Math.max(REROUTE_OFFSET_METERS, fix.accuracyM * 2)) {
      offRouteFirstFixAtRef.current = null;
      offRouteFixCountRef.current = 0;
      return;
    }
    if (offRouteFirstFixAtRef.current === null) {
      offRouteFirstFixAtRef.current = fix.timestamp;
      offRouteFixCountRef.current = 1;
      return;
    }
    offRouteFixCountRef.current += 1;
    if (offRouteFixCountRef.current < 2 ||
        fix.timestamp - offRouteFirstFixAtRef.current < REROUTE_MIN_FIX_SEPARATION_MS ||
        rerouteInFlightRef.current ||
        now - rerouteLastAttemptRef.current < REROUTE_RETRY_INTERVAL_MS) return;

    const destinationAtRequest = selectedDestinationCoordinate;
    const sessionAtRequest = rerouteSessionRef.current;
    rerouteInFlightRef.current = true;
    rerouteLastAttemptRef.current = now;
    offRouteFirstFixAtRef.current = null;
    offRouteFixCountRef.current = 0;
    showRerouteStatus("Off route — finding a new route...");

    void (async () => {
      try {
        const coordinatePair =
          `${fix.longitude},${fix.latitude};${destinationAtRequest.longitude},${destinationAtRequest.latitude}`;
        const url = `https://router.project-osrm.org/route/v1/driving/${coordinatePair}` +
          "?overview=full&geometries=geojson&steps=true";
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        let response: Response;
        try {
          response = await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!response.ok) throw new Error(`Routing HTTP ${response.status}`);
        const data = await response.json();
        const route = data?.routes?.[0];
        if (data?.code !== "Ok" || !Array.isArray(route?.geometry?.coordinates) ||
            route.geometry.coordinates.length < 2 ||
            !Number.isFinite(Number(route.distance)) ||
            !Number.isFinite(Number(route.duration))) {
          throw new Error("No replacement driving route available");
        }
        const points: Coordinate[] = route.geometry.coordinates.map((point: [number, number]) => ({
          longitude: Number(point[0]), latitude: Number(point[1]),
        }));
        if (points.some(point => !Number.isFinite(point.latitude) ||
            !Number.isFinite(point.longitude))) throw new Error("Invalid route coordinates");
        // Do not overwrite a newer destination or a stopped navigation session.
        if (sessionAtRequest !== rerouteSessionRef.current ||
            !navigationActiveRef.current ||
            destinationForRerouteRef.current?.latitude !== destinationAtRequest.latitude ||
            destinationForRerouteRef.current?.longitude !== destinationAtRequest.longitude) return;

        setRouteCoordinates(points);
        setRouteDistanceMeters(Number(route.distance));
        setRouteDurationSeconds(Number(route.duration));
        setNavigationProgress({ completedMeters: 0,
          remainingMeters: Number(route.distance), percentage: 0 });
        setNavigationOnRoute(true);
        // New geometry causes the existing route-anomaly fetch to refresh.
        alertedHazardsRef.current.clear();
        showRerouteStatus("Route updated — continue to destination", 6000);
        console.log("IRADS AUTO REROUTE SUCCESS", {
          distanceMeters: route.distance, durationSeconds: route.duration,
        });
      } catch (error) {
        if (sessionAtRequest !== rerouteSessionRef.current ||
            !navigationActiveRef.current) return;
        console.warn("IRADS AUTO REROUTE FAILED", error);
        showRerouteStatus("Could not reroute — will retry when GPS and network allow", 6500);
      } finally {
        rerouteInFlightRef.current = false;
      }
    })();
  }, [isNavigating, routeSelected, routeCoordinates, selectedDestinationCoordinate, currentLocation]);

  // Stop stale reroutes when the destination changes or navigation ends.
  useEffect(() => {
    navigationActiveRef.current = isNavigating;
    destinationForRerouteRef.current = selectedDestinationCoordinate;
    if (!isNavigating) {
      rerouteSessionRef.current += 1;
      offRouteFirstFixAtRef.current = null;
      offRouteFixCountRef.current = 0;
      if (rerouteStatusTimerRef.current !== null) clearTimeout(rerouteStatusTimerRef.current);
      setRerouteStatus(null);
    }
  }, [isNavigating, selectedDestinationCoordinate]);

  // Update progress and warn once per pothole as live GPS changes.
  // Route geometry is used so nearby roads and hazards behind the rider
  // do not generate warnings. These are foreground-only alerts.
  useEffect(() => {
    if (!isNavigating || !currentLocation || routeCoordinates.length < 2) {
      setNavigationOnRoute(false);
      return;
    }

    const rider = projectOntoRoute(currentLocation, routeCoordinates);
    if (!rider || rider.distanceToRouteMeters > MAX_RIDER_ROUTE_OFFSET_METERS) {
      setNavigationOnRoute(false);
      return;
    }
    setNavigationOnRoute(true);

    const total = calculateRouteLength(routeCoordinates);
    const completed = Math.max(0, Math.min(total, rider.distanceAlongRouteMeters));
    setNavigationProgress({
      completedMeters: completed,
      remainingMeters: Math.max(0, total - completed),
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
    });

    // Do not issue alerts from stale or low-quality GPS fixes.
    const fix = latestGpsFixRef.current;
    if (!fix || Date.now() - fix.timestamp > 10000 ||
        fix.accuracyM === null || fix.accuracyM > 30) return;

    const upcoming = hazards
      .filter((hazard) => hazard.type === "POTHOLE" &&
        !alertedHazardsRef.current.has(hazard.id))
      .map((hazard) => {
        const projected = projectOntoRoute(hazard, routeCoordinates);
        if (!projected || projected.distanceToRouteMeters > ROUTE_CORRIDOR_METERS) {
          return null;
        }
        return {
          id: hazard.id,
          confidence: hazard.confidence,
          distanceAhead: projected.distanceAlongRouteMeters - rider.distanceAlongRouteMeters,
        };
      })
      .filter((item): item is { id: string; confidence: number; distanceAhead: number } =>
        item !== null && item.distanceAhead > 0 &&
        item.distanceAhead <= POTHOLE_ALERT_DISTANCE_METERS)
      .sort((a, b) => a.distanceAhead - b.distanceAhead);

    const nearest = upcoming[0];
    if (!nearest) return;

    // Alert only once per pothole during this navigation session.
    alertedHazardsRef.current.add(nearest.id);

    const distance = Math.max(1, Math.round(nearest.distanceAhead));
    const confidence = nearest.confidence;
    const level = !Number.isFinite(confidence) || confidence < 0.7
      ? "UNKNOWN"
      : confidence >= 0.9
        ? "HIGH"
        : confidence >= 0.8
          ? "MEDIUM"
          : "LOW";

    setPotholeAheadAlert({ distance, level });
    if (potholeAheadTimerRef.current !== null) {
      clearTimeout(potholeAheadTimerRef.current);
    }
    potholeAheadTimerRef.current = setTimeout(() => {
      setPotholeAheadAlert(null);
      potholeAheadTimerRef.current = null;
    }, 4000);

    const message = `Warning! Pothole ahead in ${distance} metres.`;

    console.log("IRADS POTHOLE ALERT:", {
      anomalyId: nearest.id,
      distanceMeters: distance,
      confidenceLevel: level,
    });

    if (Platform.OS !== "web") {
      Vibration.vibrate(400);
      Speech.speak(message, {
        language: "en-IN",
        rate: 0.95,
      });
    }
  }, [isNavigating, currentLocation, routeCoordinates, hazards]);

  useEffect(() => {
    if (!isNavigating) {
      if (potholeAheadTimerRef.current !== null) {
        clearTimeout(potholeAheadTimerRef.current);
        potholeAheadTimerRef.current = null;
      }
      setPotholeAheadAlert(null);
    }
  }, [isNavigating]);

  useEffect(() => {
    return () => {
      if (potholeAheadTimerRef.current !== null) {
        clearTimeout(potholeAheadTimerRef.current);
      }
    };
  }, []);

  // ----------------------------------------------------------
  // MAP CONFIGURATION
  // ----------------------------------------------------------
  const mapCenter = currentLocation ?? INITIAL_LOCATION;

  // The backend returns active confirmed anomalies within the route corridor.
  // Locally, hide anomalies already behind the user's current route progress.
  // Before route selection, the map retains the existing nearby-raw-report behavior.
  const routeProgress = routeSelected && currentLocation && routeCoordinates.length >= 2
    ? projectOntoRoute(currentLocation, routeCoordinates)
    : null;

  // Only trim while actively navigating and close enough to the selected route.
  // Keep the full route intact when planning or temporarily off route.
  const visibleRoute = isNavigating && routeProgress &&
    routeProgress.distanceToRouteMeters <= MAX_RIDER_ROUTE_OFFSET_METERS
      ? remainingRouteGeometry(routeCoordinates, routeProgress.distanceAlongRouteMeters)
      : routeCoordinates;

  const routeHazards = routeSelected && routeCoordinates.length >= 2
    ? hazards.filter((hazard) => {
        const projection = projectOntoRoute(hazard, routeCoordinates);
        if (!projection || projection.distanceToRouteMeters > ROUTE_CORRIDOR_METERS) {
          return false;
        }
        if (routeProgress && projection.distanceAlongRouteMeters <
            routeProgress.distanceAlongRouteMeters - ROUTE_PROGRESS_TOLERANCE_METERS) {
          return false;
        }
        return true;
      })
    : hazards;

  // Show nearby confirmed anomalies when no route is selected.
  // During route selection/navigation, show only anomalies on the selected route.
  const mapHazards = routeSelected ? routeHazards : nearbyConfirmedHazards;
// ----------------------------------------------------------
  // MESSAGES
  // ----------------------------------------------------------

  function showMessage(title: string, message: string) {
    if (Platform.OS === "web") {
      window.alert(`${title}\n\n${message}`);
    } else {
      Alert.alert(title, message);
    }
  }

  // ----------------------------------------------------------
  // SOURCE SEARCH, DESTINATION SEARCH AND ROUTING
  // ----------------------------------------------------------

  function resetPlannedRoute() {
    setRouteSelected(false);
    setIsNavigating(false);
    setRouteCoordinates([]);
    setRouteDistanceMeters(null);
    setRouteDurationSeconds(null);
    setHazards([]);
    setHazardError(null);
    alertedHazardsRef.current.clear();
  }

  // Long-press a map point to choose a start or destination without geocoding.
  // While navigating, the live GPS route remains the only navigation source.
  function handleMapLongPress(coordinate: Coordinate) {
    if (isNavigating || loadingRoute) return;
    setPendingMapCoordinate(coordinate);
  }

  function handleUseMapPoint(kind: "source" | "destination") {
    const coordinate = pendingMapCoordinate;
    if (!coordinate || isNavigating || loadingRoute) return;
    const coordinateLabel = `${coordinate.latitude.toFixed(5)}, ${coordinate.longitude.toFixed(5)}`;
    resetPlannedRoute();
    setSourceResults([]);
    setDestinationResults([]);
    setNearbyPlaces([]);
    setNearbyCategory(null);
    if (kind === "source") {
      setSource(`Map: ${coordinateLabel}`);
      setSelectedSourceCoordinate(coordinate);
    } else {
      setDestination(`Map: ${coordinateLabel}`);
      setSelectedDestinationCoordinate(coordinate);
    }
    setPendingMapCoordinate(null);
  }

  function handleSwapLocations() {
    if (loadingRoute || searchingDestination) return;
    // A symbolic "My location" must be frozen to its current GPS coordinates
    // when moved to the destination field; otherwise a route could chase itself.
    const oldOrigin = selectedSourceCoordinate ?? currentLocation;
    const oldDestination = selectedDestinationCoordinate;
    if (!oldOrigin || !oldDestination) {
      showMessage("Select both locations", "Choose a starting point and select a destination result before swapping.");
      return;
    }
    const oldSourceLabel = source.trim().toLowerCase() === "my location"
      ? "Previous starting location"
      : source;
    setSource(destination);
    setSelectedSourceCoordinate(oldDestination);
    setDestination(oldSourceLabel);
    setSelectedDestinationCoordinate(oldOrigin);
    setSourceResults([]);
    setDestinationResults([]);
    setNearbyPlaces([]);
    setNearbyCategory(null);
    resetPlannedRoute();
    showMessage("Locations swapped", "Tap GO to find the return route. Your previous GPS starting point is fixed as the destination.");
  }

  async function handleSearchNearby(category: string) {
    const center = currentLocation ?? selectedSourceCoordinate;
    if (!center) {
      showMessage("Location unavailable", "Wait for GPS or select a starting point before searching nearby places.");
      return;
    }
    const filters: Record<string, string> = {
      Hospital: '["amenity"="hospital"]',
      Fuel: '["amenity"="fuel"]',
      Restaurant: '["amenity"="restaurant"]',
      Cafe: '["amenity"="cafe"]',
      Pharmacy: '["amenity"="pharmacy"]',
      Parking: '["amenity"="parking"]',
      Metro: '["railway"="station"]["station"="subway"]',
    };
    const filter = filters[category];
    if (!filter) return;
    const request = ++nearbyRequestRef.current;
    setNearbyCategory(category);
    setNearbyPlaces([]);
    setLoadingNearby(true);
    try {
      const radius = 5000;
      const query = `[out:json][timeout:20];(nwr(around:${radius},${center.latitude},${center.longitude})${filter};);out center 30;`;
      const response = await fetch("https://overpass.kumi.systems/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!response.ok) throw new Error(`Nearby search returned HTTP ${response.status}.`);
      const json = await response.json();
      const elements = Array.isArray(json?.elements) ? json.elements : [];
      const places: DestinationResult[] = elements.map((item: any) => {
        const lat = Number(item.lat ?? item.center?.lat);
        const lon = Number(item.lon ?? item.center?.lon);
        const name = String(item.tags?.name ?? `${category} (${item.id})`);
        const address = [item.tags?.["addr:street"], item.tags?.["addr:suburb"], item.tags?.["addr:city"]]
          .filter(Boolean).join(", ");
        return { id: `${item.type}-${item.id}`, name, address: address || category,
          coordinate: { latitude: lat, longitude: lon } };
      }).filter((place: DestinationResult) =>
        Number.isFinite(place.coordinate.latitude) && Number.isFinite(place.coordinate.longitude))
        .sort((a: DestinationResult, b: DestinationResult) =>
          distanceMeters(center, a.coordinate) - distanceMeters(center, b.coordinate))
        .slice(0, 12);
      if (request !== nearbyRequestRef.current) return;
      setNearbyPlaces(places);
      if (!places.length) showMessage("No nearby places found", `No mapped ${category.toLowerCase()} locations were returned within 5 km.`);
    } catch (error) {
      if (request !== nearbyRequestRef.current) return;
      showMessage("Nearby search unavailable", error instanceof Error ? error.message : "Check your internet connection and retry.");
    } finally {
      if (request === nearbyRequestRef.current) setLoadingNearby(false);
    }
  }

  async function handleSearchSource() {
    const query = source.trim();
    if (!query || query.toLowerCase() === "my location") {
      setSource("My location");
      setSelectedSourceCoordinate(null);
      setSourceResults([]);
      return;
    }

    setSourceResults([]);
    try {
      const params = new URLSearchParams({ q: query, limit: "5" });
      if (currentLocation) {
        params.set("lat", String(currentLocation.latitude));
        params.set("lon", String(currentLocation.longitude));
      }
      const response = await fetch(
        `https://photon.komoot.io/api/?${params.toString()}`,
        { headers: { Accept: "application/geo+json" } },
      );
      if (!response.ok) throw new Error(`Source search returned HTTP ${response.status}.`);
      const results = await response.json();
      const features = Array.isArray(results?.features) ? results.features : [];
      const places: DestinationResult[] = features
        .filter((feature: any) => Array.isArray(feature?.geometry?.coordinates) && feature.geometry.coordinates.length >= 2)
        .map((feature: any, index: number) => {
          const properties = feature.properties ?? {};
          const name = String(properties.name || properties.street || properties.city || query);
          const address = [properties.name, properties.street, properties.housenumber, properties.district, properties.city, properties.state, properties.country]
            .filter(Boolean).map(String).filter((value, i, arr) => arr.indexOf(value) === i).join(", ");
          return {
            id: String(properties.osm_id ?? `${name}-${index}`),
            name,
            address: address || name,
            coordinate: { longitude: Number(feature.geometry.coordinates[0]), latitude: Number(feature.geometry.coordinates[1]) },
          };
        })
        .filter((place: DestinationResult) => Number.isFinite(place.coordinate.latitude) && Number.isFinite(place.coordinate.longitude));
      setSourceResults(places);
      if (!places.length) showMessage("No starting locations found", "Try a more specific address or landmark.");
    } catch (error) {
      console.error("Source search failed:", error);
      showMessage("Source search failed", error instanceof Error ? error.message : "Check your internet connection and try again.");
    }
  }

  function handleUseMyLocation() {
    setSource("My location");
    setSelectedSourceCoordinate(null);
    setSourceResults([]);
    setSelectedDestinationCoordinate(null);
    setRouteSelected(false);
    setIsNavigating(false);
    setRouteCoordinates([]);
    setRouteDistanceMeters(null);
    setRouteDurationSeconds(null);
    setHazards([]);
  }

  function handleSelectSource(place: DestinationResult) {
    setSource(place.name);
    setSelectedSourceCoordinate(place.coordinate);
    setSourceResults([]);
    setSelectedDestinationCoordinate(null);
    setRouteSelected(false);
    setIsNavigating(false);
    setRouteCoordinates([]);
    setRouteDistanceMeters(null);
    setRouteDurationSeconds(null);
    setHazards([]);
  }

  async function handleSearchRoute() {
    const query = destination.trim();

    if (!query) {
      showMessage("Destination required", "Enter a place, address, or landmark to search.");
      return;
    }
    if (selectedDestinationCoordinate) {
      void handleSelectDestination({
        id: "selected-destination", name: destination, address: destination,
        coordinate: selectedDestinationCoordinate,
      });
      return;
    }

    setSearchingDestination(true);
    setDestinationResults([]);
    setSelectedDestinationCoordinate(null);
    setRouteSelected(false);
    setIsNavigating(false);
    setRouteCoordinates([]);
    setRouteDistanceMeters(null);
    setRouteDurationSeconds(null);

    try {
      // Photon is used instead of calling Nominatim directly from the app.
      // Public geocoding services may rate-limit or block mobile requests.
      // Constrain Photon to Bengaluru for local landmark searches. Photon is global:
      // without a geographic bound, "Trinity" can resolve to a US location.
      const bengaluruArea = { west: 77.35, south: 12.73, east: 77.94, north: 13.23 };
      const center = currentLocation ?? INITIAL_LOCATION;
      const nearBengaluru = center.latitude >= 12.6 && center.latitude <= 13.4 &&
        center.longitude >= 77.2 && center.longitude <= 78.1;
      const area = nearBengaluru ? bengaluruArea : {
        west: center.longitude - 0.25, east: center.longitude + 0.25,
        south: center.latitude - 0.25, north: center.latitude + 0.25,
      };
      const queries = [query];
      if (/bengaluru|bangalore/i.test(query)) {
        const shorter = query.replace(/\b(bengaluru|bangalore)\b/gi, "").replace(/[, ]+/g, " ").trim();
        if (shorter && shorter !== query) queries.push(shorter);
      }
      if (/\btrinity\b/i.test(query)) queries.push("Trinity Metro Station");
      let features: any[] = [];
      for (const phrase of [...new Set(queries)]) {
        const params = new URLSearchParams({ q: phrase, limit: "15",
          bbox: `${area.west},${area.south},${area.east},${area.north}`,
          lat: String(center.latitude), lon: String(center.longitude) });
        const response = await fetch(`https://photon.komoot.io/api/?${params.toString()}`,
          { headers: { Accept: "application/geo+json" } });
        if (!response.ok) throw new Error(`Destination search returned HTTP ${response.status}.`);
        const results = await response.json();
        const matching = Array.isArray(results?.features) ? results.features : [];
        features.push(...matching);
        if (features.length >= 8) break;
      }
      const places: DestinationResult[] = features
        .filter((feature: any) =>
          Array.isArray(feature?.geometry?.coordinates) &&
          feature.geometry.coordinates.length >= 2 &&
          Number.isFinite(Number(feature.geometry.coordinates[0])) &&
          Number.isFinite(Number(feature.geometry.coordinates[1]))
        )
        .map((feature: any, index: number) => {
          const properties = feature.properties ?? {};
          const name = String(
            properties.name || properties.street || properties.city || properties.state || query
          );
          const address = [
            properties.name,
            properties.street,
            properties.housenumber,
            properties.district,
            properties.city,
            properties.state,
            properties.country,
          ].filter(Boolean).map(String).filter((value, i, arr) => arr.indexOf(value) === i).join(", ");

          return {
            id: String(properties.osm_id ?? `${name}-${index}`),
            name,
            address: address || name,
            coordinate: {
              longitude: Number(feature.geometry.coordinates[0]),
              latitude: Number(feature.geometry.coordinates[1]),
            },
          };
        })
        .filter((place: DestinationResult) =>
          place.coordinate.latitude >= area.south && place.coordinate.latitude <= area.north &&
          place.coordinate.longitude >= area.west && place.coordinate.longitude <= area.east)
        .filter((place: DestinationResult, i: number, all: DestinationResult[]) =>
          all.findIndex((candidate) => candidate.id === place.id) === i)
        .sort((a: DestinationResult, b: DestinationResult) =>
          distanceMeters(center, a.coordinate) - distanceMeters(center, b.coordinate))
        .slice(0, 10);

      setDestinationResults(places);

      if (places.length === 0) {
        showMessage("No destinations found", "Try a more specific place name or address.");
      }
    } catch (error) {
      console.error("Destination search failed:", error);
      showMessage(
        "Search failed",
        error instanceof Error ? error.message : "Could not search destinations. Check your internet connection."
      );
    } finally {
      setSearchingDestination(false);
    }
  }

  async function handleSelectDestination(place: DestinationResult) {
    const origin = selectedSourceCoordinate ?? currentLocation;
    if (!origin) {
      showMessage("Starting location unavailable", "Choose a starting location or allow location access to use My location.");
      return;
    }

    setDestination(place.name);
    setDestinationSearchOpen(false);
    setNearbyPlaces([]);
    setNearbyCategory(null);
    setDestinationResults([]);
    setLoadingRoute(true);
    setSelectedDestinationCoordinate(null);
    setRouteSelected(false);
    setIsNavigating(false);
    setRouteCoordinates([]);
    setHazards([]);
    setHazardError(null);

    try {
      // OSRM expects longitude,latitude coordinate order.
      const coordinates =
        `${origin.longitude},${origin.latitude};` +
        `${place.coordinate.longitude},${place.coordinate.latitude}`;
      const url =
        `https://router.project-osrm.org/route/v1/driving/${coordinates}` +
        "?overview=full&geometries=geojson&steps=true";

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Routing service returned HTTP ${response.status}.`);
      }

      const data = await response.json();
      const route = data?.routes?.[0];

      if (data?.code !== "Ok" || !route?.geometry?.coordinates?.length) {
        throw new Error("No driving route was found for that destination.");
      }

      const points: Coordinate[] = route.geometry.coordinates.map(
        (point: [number, number]) => ({
          longitude: Number(point[0]),
          latitude: Number(point[1]),
        })
      );

      // Demo preparation: log exact coordinates sampled from the calculated route.
      const demoFractions = [0.15, 0.35, 0.55, 0.75, 0.90];
      const demoRoutePoints = demoFractions.map((fraction, index) => {
        const pointIndex = Math.max(
          0,
          Math.min(points.length - 1, Math.round((points.length - 1) * fraction)),
        );
        return { slot: index + 1, fraction, ...points[pointIndex] };
      });
      console.log("IRADS_DEMO_ROUTE_POINTS_JSON:" + JSON.stringify(demoRoutePoints));
      // Select a repeatable point on the calculated route for the temporary
      // route-anomaly test. Copy these coordinates from the Expo logs when
      // creating a controlled demo anomaly; this does not write to the database.
      const testPointIndex = Math.max(
        0,
        Math.min(points.length - 1, Math.floor((points.length - 1) * 0.75)),
      );
      console.log(
        "IRADS_TEMP_ANOMALY_ROUTE_POINT:",
        points[testPointIndex],
      );

      setRouteCoordinates(points);
      setSelectedDestinationCoordinate(place.coordinate);
      setRouteDistanceMeters(Number(route.distance));
      setRouteDurationSeconds(Number(route.duration));
      setRouteSelected(true);

      showMessage(
        "Route ready",
        `From: ${source.trim() || "My location"}\nTo: ${place.name}\nDistance: ${(Number(route.distance) / 1000).toFixed(1)} km\nEstimated driving time: ${Math.max(1, Math.round(Number(route.duration) / 60))} min`
      );
    } catch (error) {
      console.error("Route calculation failed:", error);
        showMessage(
        "Could not calculate route",
        error instanceof Error ? error.message : "Check your internet connection and try again."
      );
    } finally {
      setLoadingRoute(false);
    }
  }

  function formatRouteDistance(meters: number | null) {
    if (meters === null || !Number.isFinite(meters)) return "--";
    return meters >= 1000
      ? `${(meters / 1000).toFixed(1)} km`
      : `${Math.round(meters)} m`;
  }

  function formatRouteDuration(seconds: number | null) {
    if (seconds === null || !Number.isFinite(seconds)) return "--";
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes ? `${hours} h ${remainingMinutes} min` : `${hours} h`;
  }

  // ----------------------------------------------------------
  // NAVIGATION
  // ----------------------------------------------------------

  function handleNavigation() {
    if (!routeSelected) {
      showMessage(
        "Plan a route first",
        "Enter your destination and select GO."
      );

      return;
    }

    if (!isNavigating) {
      const liveFix = latestGpsFixRef.current;
      if (!currentLocation || !liveFix ||
          Date.now() - liveFix.timestamp > 10_000 ||
          liveFix.accuracyM === null || liveFix.accuracyM > 30) {
        showMessage("GPS unavailable", "Wait for a fresh, accurate GPS position before navigating.");
        return;
      }
      alertedHazardsRef.current.clear();
      setNavigationProgress({ completedMeters: 0, remainingMeters: 0, percentage: 0 });
    } else if (Platform.OS !== "web") {
      Speech.stop();
    }
    setIsNavigating((previous) => !previous);
  }

  // ----------------------------------------------------------
  // MY LOCATION
  // ----------------------------------------------------------

  function handleMyLocation() {
    if (!currentLocation) {
      showMessage(
        "Location unavailable",
        "Allow location access and wait for your GPS position to load.",
      );
      return;
    }

    setRecenterRequest((request) => request + 1);
  }

  // ----------------------------------------------------------
  // SETTINGS
  // ----------------------------------------------------------

  function handleSettings() {
    setSettingsVisible(true);
  }

  // ----------------------------------------------------------
  // UI
  // ----------------------------------------------------------

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar
        barStyle="light-content"
        backgroundColor="#101820"
      />

      {/* Header */}

      <View style={styles.header}>
        <View>
          <Text style={styles.logo}>IRADS</Text>
          <Text style={styles.subtitle}>Road intelligence | BUILD 31OCT-G · {modelInitStatus === "ready" ? "AI ready" : modelInitStatus === "error" ? "AI error" : "AI loading"}</Text>
        </View>

        <TouchableOpacity
          style={styles.settingsButton}
          onPress={handleSettings}
          accessibilityLabel="Settings"
        >
          <Text style={styles.settingsIcon}>{"\u2699\uFE0E"}</Text>
        </TouchableOpacity>
      </View>

      {/* Source and destination */}

      {!isNavigating ? <View style={styles.searchPanel}>
        <View style={styles.searchRow}>
          <View style={styles.sourceDot} />

          <TextInput
            style={styles.searchInput}
            value={source}
            onChangeText={(text) => {
              setSource(text);
              setSelectedSourceCoordinate(null);
              setSourceResults([]);
              setSelectedDestinationCoordinate(null);
              setRouteSelected(false);
              setIsNavigating(false);
              setRouteCoordinates([]);
              setRouteDistanceMeters(null);
              setRouteDurationSeconds(null);
              setHazards([]);
            }}
            placeholder="Starting location or My location"
            placeholderTextColor="#8995A3"
            returnKeyType="search"
            onSubmitEditing={() => void handleSearchSource()}
            accessibilityLabel="Starting location"
          />
          <View style={styles.speedChip}>
            <Text style={styles.speedChipValue}>{speedKmh === null ? "--" : speedKmh.toFixed(1)}</Text>
            <Text style={styles.speedChipUnit}>km/h</Text>
          </View>
          {source.trim().toLowerCase() === "my location" ? (
            <TouchableOpacity style={styles.sourceActionButton} onPress={handleUseMyLocation}>
              <Text style={styles.sourceActionButtonText}>GPS</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.sourceActionButton} onPress={() => void handleSearchSource()}>
              <Text style={styles.sourceActionButtonText}>SET</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={{ alignItems: "center", paddingVertical: 3 }}>
          <TouchableOpacity onPress={handleSwapLocations} accessibilityLabel="Swap source and destination"
            style={{ backgroundColor: "#23384C", paddingVertical: 4, paddingHorizontal: 14, borderRadius: 8 }}>
            <Text style={{ color: "#E2E8F0", fontWeight: "700", fontSize: 12 }}>⇅ Swap locations</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.searchDivider} />

        <View style={styles.searchRow}>
          <View style={styles.destinationPin} />

          <TouchableOpacity
            style={{ flex: 1, justifyContent: "center", minHeight: 48 }}
            accessibilityRole="button"
            accessibilityLabel="Search for a destination or nearby places"
            onPress={() => setDestinationSearchOpen(true)}
          >
            <Text numberOfLines={1} style={{ color: destination ? "#F8FAFC" : "#A7B3C2", fontSize: 14 }}>
              {destination || "Search destination or nearby places"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.searchButton}
            onPress={() => {
              if (selectedDestinationCoordinate) void handleSearchRoute();
              else setDestinationSearchOpen(true);
            }}
          >
            <Text style={styles.searchButtonText}>{selectedDestinationCoordinate ? "GO" : "SEARCH"}</Text>
          </TouchableOpacity>
        </View>
      </View> : null}

      {isNavigating && rerouteStatus !== null && (
        <View style={styles.rerouteBanner}>
          {rerouteStatus.startsWith("Off route") && <ActivityIndicator size="small" color="#FBBF24" />}
          <Text style={styles.rerouteBannerText}>{rerouteStatus}</Text>
        </View>
      )}

      {isNavigating && (
        <View style={styles.navDestinationBanner}>
          <Text style={styles.navDestinationText} numberOfLines={1}>Navigating to {destination}</Text>
        </View>
      )}

      {/* Search results live in a dedicated modal rather than pushing the map down. */}
      <Modal
        visible={destinationSearchOpen && !isNavigating}
        animationType="slide"
        transparent
        onRequestClose={() => setDestinationSearchOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(4, 10, 17, 0.93)", paddingTop: 56 }}>
          <View style={{ backgroundColor: "#172433", marginHorizontal: 12, borderRadius: 18, padding: 16, flex: 1, marginBottom: 20 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <Text style={{ fontSize: 20, fontWeight: "800", color: "#F8FAFC" }}>Choose destination</Text>
              <TouchableOpacity onPress={() => setDestinationSearchOpen(false)} accessibilityLabel="Close destination search">
                <Text style={{ color: "#CBD5E1", fontWeight: "800", fontSize: 24 }}>×</Text>
              </TouchableOpacity>
            </View>
            <View style={{ backgroundColor: "#26384A", borderRadius: 12, flexDirection: "row", alignItems: "center", paddingLeft: 12, marginBottom: 16 }}>
              <TextInput
                style={[styles.searchInput, { minHeight: 52 }]}
                value={destination}
                onChangeText={(text) => {
                  setDestination(text);
                  setDestinationResults([]);
                  setSelectedDestinationCoordinate(null);
                  setRouteSelected(false);
                  setRouteCoordinates([]);
                  setRouteDistanceMeters(null);
                  setRouteDurationSeconds(null);
                  setHazards([]);
                }}
                placeholder="Try Trinity Metro Station, Bengaluru"
                placeholderTextColor="#A7B3C2"
                returnKeyType="search"
                onSubmitEditing={() => void handleSearchRoute()}
                accessibilityLabel="Search destination text"
              />
              <TouchableOpacity onPress={() => void handleSearchRoute()} style={[styles.searchButton, { marginRight: 6 }]}>
                <Text style={styles.searchButtonText}>Find</Text>
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={false}>
              <Text style={{ color: "#CBD5E1", fontWeight: "700", marginBottom: 10 }}>NEARBY PLACES · within 5 km</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                {["Hospital", "Fuel", "Restaurant", "Cafe", "Pharmacy", "Parking", "Metro"].map((category) => (
                  <TouchableOpacity key={category} disabled={loadingNearby}
                    onPress={() => void handleSearchNearby(category)}
                    style={{ backgroundColor: nearbyCategory === category ? "#0F766E" : "#2A4054",
                      borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11 }}>
                    <Text style={{ color: "#FFFFFF", fontSize: 13 }}>{category}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {searchingDestination && <ActivityIndicator color="#38BDF8" size="small" />}
              {loadingNearby && <Text style={styles.destinationResultText}>Finding nearby {nearbyCategory?.toLowerCase()} places...</Text>}
              {loadingRoute && <Text style={styles.destinationResultText}>Calculating driving route...</Text>}
              {destinationResults.map((place) => (
                <TouchableOpacity key={`search-${place.id}`} style={styles.destinationResultItem}
                  onPress={() => void handleSelectDestination(place)}>
                  <Text style={styles.destinationResultName}>{place.name}</Text>
                  <Text style={styles.destinationResultAddress}>{place.address}</Text>
                </TouchableOpacity>
              ))}
              {nearbyPlaces.length > 0 && <Text style={[styles.destinationResultText, { marginTop: 14 }]}>Nearby {nearbyCategory}</Text>}
              {nearbyPlaces.map((place) => (
                <TouchableOpacity key={`nearby-${place.id}`} style={styles.destinationResultItem}
                  onPress={() => void handleSelectDestination(place)}>
                  <Text style={styles.destinationResultName}>{place.name}</Text>
                  <Text style={styles.destinationResultAddress}>{place.address}</Text>
                </TouchableOpacity>
              ))}
              <Text style={[styles.attributionText, { marginTop: 16 }]}>Search data © OpenStreetMap contributors</Text>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {sourceResults.length > 0 && (
        <View style={styles.destinationResultsPanel}>
          {sourceResults.map((place) => (
            <TouchableOpacity key={place.id} style={styles.destinationResultItem} onPress={() => handleSelectSource(place)}>
              <Text style={styles.destinationResultName}>{place.name}</Text>
              <Text style={styles.destinationResultAddress}>{place.address}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.destinationResultItem} onPress={handleUseMyLocation}>
            <Text style={styles.destinationResultName}>Use my current location instead</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Map */}

      <View style={styles.mapContainer}>
        {/* Show the live GPS marker and follow the rider while navigating. */}
        <IRADSMapWithDestination
          currentLocation={currentLocation}
          isNavigating={isNavigating}
          initialCenter={mapCenter}
          routeSelected={routeSelected}
          showHeatmap={showHeatmap}
          route={routeCoordinates}
          visibleRoute={visibleRoute}
          hazards={mapHazards}
          sourceCoordinate={selectedSourceCoordinate}
          sourceLabel={source || "Starting point"}
          destinationCoordinate={selectedDestinationCoordinate}
          destinationLabel={destination || "Destination"}
          pendingMapCoordinate={pendingMapCoordinate}
          onMapLongPress={handleMapLongPress}
          recenterRequest={recenterRequest}
        />

        {!isNavigating && pendingMapCoordinate && (
          <View style={{ position: "absolute", left: 12, right: 12, top: 12,
            backgroundColor: "#142637", padding: 12, borderRadius: 12,
            borderWidth: 1, borderColor: "#38BDF8", elevation: 6 }}>
            <Text style={{ color: "#F8FAFC", fontWeight: "700", marginBottom: 4 }}>
              Selected point: {pendingMapCoordinate.latitude.toFixed(5)}, {pendingMapCoordinate.longitude.toFixed(5)}
            </Text>
            <Text style={{ color: "#94A3B8", fontSize: 12, marginBottom: 9 }}>
              Use this map location as your starting point or destination.
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity onPress={() => handleUseMapPoint("source")}
                style={{ flex: 1, backgroundColor: "#166534", padding: 10, borderRadius: 8, alignItems: "center" }}>
                <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>Set Source</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleUseMapPoint("destination")}
                style={{ flex: 1, backgroundColor: "#1D4ED8", padding: 10, borderRadius: 8, alignItems: "center" }}>
                <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>Set Destination</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setPendingMapCoordinate(null)}
                style={{ backgroundColor: "#475569", padding: 10, borderRadius: 8, alignItems: "center" }}>
                <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>×</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {(loadingLocation || locationNotice) && (
          <View style={styles.locationBadge}>
            {loadingLocation && <ActivityIndicator size="small" color="#38BDF8" />}
            <Text style={styles.locationBadgeText}>
              {locationNotice ?? "Locating you..."}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={styles.myLocationButton}
          onPress={handleMyLocation}
          accessibilityLabel="Show my location"
        >
          <View style={styles.locationCrosshair}>
            <View style={styles.crosshairRing} />
            <View style={styles.crosshairCenter} />
            <View style={[styles.crosshairTick, styles.crosshairTop]} />
            <View style={[styles.crosshairTick, styles.crosshairBottom]} />
            <View style={[styles.crosshairTickHorizontal, styles.crosshairLeft]} />
            <View style={[styles.crosshairTickHorizontal, styles.crosshairRight]} />
          </View>
        </TouchableOpacity>
      </View>

      {/* Navigation essentials stay visible without scrolling. */}
      {isNavigating && routeSelected && (
        <View style={styles.activeNavigationBar}>
          <View style={styles.activeNavigationStats}>
            <View style={styles.activeNavigationMetric}>
              <Text style={styles.activeNavigationLabel}>DISTANCE LEFT</Text>
              <Text style={styles.activeNavigationValue}>
                {navigationOnRoute
                  ? formatRouteDistance(navigationProgress.remainingMeters)
                  : "Off route"}
              </Text>
            </View>
            <View style={styles.activeNavigationMetric}>
              <Text style={styles.activeNavigationLabel}>SPEED</Text>
              <Text style={styles.activeNavigationValue}>
                {speedKmh === null ? "--" : speedKmh.toFixed(1)}
                <Text style={styles.activeNavigationUnit}> km/h</Text>
              </Text>
            </View>
          </View>
          <TouchableOpacity
            style={styles.quickStopButton}
            onPress={handleNavigation}
            accessibilityRole="button"
            accessibilityLabel="Stop navigation"
          >
            <Text style={styles.quickStopText}>Stop navigation</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Bottom panel */}

      {!isNavigating && <View style={styles.bottomPanel}>
        {/* Live anomaly status */}

        <View style={styles.anomalyStatus}>
          {loadingHazards ? (
            <>
              <ActivityIndicator
                size="small"
                color="#38BDF8"
              />

              <Text style={styles.statusText}>
                {routeSelected
                  ? "Loading anomalies along your route..."
                  : "Loading nearby road anomalies..."}
              </Text>
            </>
          ) : hazardError ? (
            <Text style={styles.errorText}>
              Could not load anomalies: {hazardError}
            </Text>
          ) : (
            <Text style={styles.statusText}>
              {routeSelected
                ? `${routeHazards.length} anomalies along your route ahead`
                : `${nearbyConfirmedHazards.length} confirmed anomalies within 10 km`}
            </Text>
          )}
        </View>

        <View style={styles.routeCard}>
          <View style={styles.routeHeader}>
            <Text style={styles.routeTitle}>
              {routeSelected
                ? "Selected route"
                : "Plan your journey"}
            </Text>

            {routeSelected && (
              <View style={styles.routeBadge}>
                <Text style={styles.routeBadgeText}>
                  LIVE ROUTE
                </Text>
              </View>
            )}
          </View>

          {routeSelected ? (
            <>
              <View style={styles.routeStats}>
                <View>
                  <Text style={styles.routeDistance}>
                    {formatRouteDistance(routeDistanceMeters)}
                  </Text>

                  <Text style={styles.statLabel}>
                    Distance
                  </Text>
                </View>

                <View>
                  <Text style={styles.routeDistance}>
                    {formatRouteDuration(routeDurationSeconds)}
                  </Text>

                  <Text style={styles.statLabel}>
                    Estimated time
                  </Text>
                </View>

                <View>
                  <Text style={styles.routeDistance}>
                    {routeHazards.length}
                  </Text>

                  <Text style={styles.statLabel}>
                    Anomalies on route
                  </Text>
                </View>
              </View>


            </>
          ) : (
            <Text style={styles.emptyRouteText}>
              Search for a destination to explore route
              information.
            </Text>
          )}

          {isNavigating && routeSelected && (
            <View style={{ paddingVertical: 12 }}>
              <Text style={styles.routeDistance}>
                Journey completed: {navigationProgress.percentage}%
              </Text>
              <Text style={styles.statusText}>
                Travelled: {formatRouteDistance(navigationProgress.completedMeters)}
              </Text>
              <Text style={styles.statusText}>
                Remaining: {formatRouteDistance(navigationProgress.remainingMeters)}
              </Text>
              {!navigationOnRoute && (
                <Text style={styles.errorText}>
                  GPS is off the selected route or unavailable. Progress and alerts paused.
                </Text>
              )}
              <View style={{ height: 8, backgroundColor: "#334155", borderRadius: 4,
                marginTop: 10, overflow: "hidden" }}>
                <View style={{ height: "100%", width: `${navigationProgress.percentage}%`,
                  backgroundColor: "#38BDF8" }} />
              </View>
            </View>
          )}

          <TouchableOpacity
            style={[
              styles.navigationButton,
              isNavigating && styles.stopNavigationButton,
            ]}
            onPress={handleNavigation}
          >
            <Text style={styles.navigationButtonText}>
              {isNavigating
                ? "Stop navigation"
                : "Start navigation"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>}

      <Modal
        visible={settingsVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setSettingsVisible(false)}
      >
        <View style={styles.settingsBackdrop}>
          <View style={styles.settingsSheet}>
            <ScrollView keyboardShouldPersistTaps="handled">
            <View style={styles.settingsSheetHeader}>
              <Text style={styles.settingsSheetTitle}>Settings</Text>
              <TouchableOpacity
                onPress={() => setSettingsVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Close settings"
                style={styles.settingsCloseButton}
              >
                <Text style={styles.settingsCloseText}>X</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.settingsOptionRow}>
              <View style={styles.settingsOptionDetails}>
                <Text style={styles.settingsOptionTitle}>Show road anomalies</Text>
                <Text style={styles.settingsOptionHint}>Display reported hazards on the map</Text>
              </View>
              <Switch
                value={showHeatmap}
                onValueChange={setShowHeatmap}
                trackColor={{ false: "#344054", true: "#0F766E" }}
                thumbColor={showHeatmap ? "#5EEAD4" : "#D0D5DD"}
              />
            </View>
            {Platform.OS !== "web" && (
              <View style={styles.pilotSection}>
                <Text style={styles.settingsInfoHeading}>Automatic device registration</Text>
                <Text style={styles.settingsOptionHint}>
                  No pilot access key is required. Registration and authentication
                  happen automatically when pending anomaly reports are synchronized.
                </Text>
                <Text style={styles.pilotDeviceIdLabel}>Device ID</Text>
                <Text selectable style={styles.pilotDeviceIdValue}>
                  {registeredDeviceId || "Unavailable"}
                </Text>
                <Text style={styles.settingsOptionHint}>
                  Having a device ID does not confirm server registration.
                </Text>
              </View>
            )}
            <View style={styles.settingsInfoSection}>
              <Text style={styles.settingsInfoHeading}>Device status</Text>
              <Text style={styles.settingsInfoText}>GPS: {currentLocation ? "Connected" : "Unavailable"}</Text>
              <Text style={styles.settingsInfoText}>
                Speed: {speedKmh === null ? "Unavailable" : `${speedKmh.toFixed(1)} km/h`}
              </Text>
              <Text style={styles.settingsInfoText}>Navigation: {isNavigating ? "Active" : "Inactive"}</Text>
            </View>
            <Text style={styles.settingsFootnote}>
              Alert preferences are not available yet.
            </Text>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Raw classifier diagnostic. Independent of GPS, speed and database saving. */}
      {predictionBanner !== null && (
        <View pointerEvents="none" style={styles.predictionBanner}>
          <Text style={styles.predictionBannerTitle}>
            {predictionBanner.type === "POTHOLE" ? "AI predicts: POTHOLE" : "AI predicts: SPEED BREAKER"}
          </Text>
          <Text style={styles.predictionBannerInfo}>
            Confidence: {(predictionBanner.confidence * 100).toFixed(1)}%  |  Predictions: {predictionBanner.count}
          </Text>
          <Text style={styles.predictionBannerHint}>
            Diagnostic prediction only — not necessarily saved
          </Text>
        </View>
      )}

      {/* Keep diagnostics in the model status state, not covering the map. */}
      {isNavigating && potholeAheadAlert !== null && (
        <View pointerEvents="none" style={styles.potholeAheadPopup}>
          <View style={styles.potholeAheadHeader}>
            <Text style={styles.potholeAheadTitle}>⚠ Pothole Ahead!</Text>
            <View style={[
              styles.potholeAheadBadge,
              { backgroundColor: potholeAheadAlert.level === "HIGH" ? "#5B2A35"
                : potholeAheadAlert.level === "MEDIUM" ? "#664719"
                : potholeAheadAlert.level === "LOW" ? "#1B5E42" : "#475569" },
            ]}>
              <Text style={styles.potholeAheadBadgeText}>{potholeAheadAlert.level}</Text>
            </View>
          </View>
          <Text style={styles.potholeAheadDistance}>
            {potholeAheadAlert.distance} m ahead
          </Text>
          <Text style={styles.potholeAheadSubtitle}>
            Caution: Road anomaly detected on your route
          </Text>
        </View>
      )}

      {detectionToast !== null && (
        <View
          pointerEvents="none"
          style={styles.detectionToast}
        >
          <Text style={styles.detectionToastTitle}>
            {detectionToast === "POTHOLE"
              ? "Pothole Detected!"
              : "Speed Breaker Detected!"}
          </Text>
          <Text style={styles.detectionToastSubtitle}>
            Saved locally - Upload pending
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

// ============================================================
// STYLES
// ============================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#101820",
  },

  modelInitBanner: {
    position: "absolute",
    top: 66,
    left: 12,
    right: 12,
    zIndex: 1200,
    elevation: 15,
    backgroundColor: "#1E293B",
    borderColor: "#475569",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  modelInitText: {
    color: "#F8FAFC",
    textAlign: "center",
    fontSize: 12,
    fontWeight: "700",
  },

  liveSensorPanel: {
    position: "absolute",
    bottom: 120,
    left: 12,
    right: 12,
    zIndex: 1100,
    elevation: 14,
    backgroundColor: "rgba(15, 23, 42, 0.94)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#475569",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  liveSensorHeading: {
    color: "#93C5FD",
    fontSize: 11,
    fontWeight: "800",
    marginBottom: 5,
  },
  liveSensorValue: {
    color: "#F8FAFC",
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    marginBottom: 3,
  },
  liveSensorMeta: {
    color: "#CBD5E1",
    fontSize: 10,
    marginTop: 4,
  },

  potholeAheadPopup: {
    position: "absolute",
    top: 75,
    left: 12,
    right: 12,
    zIndex: 2000,
    elevation: 20,
    backgroundColor: "#1F2937",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#334155",
    padding: 16,
    gap: 15,
  },
  potholeAheadHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  potholeAheadTitle: {
    color: "#F8FAFC",
    fontSize: 19,
    fontWeight: "700",
  },
  potholeAheadBadge: {
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  potholeAheadBadgeText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "800",
  },
  potholeAheadDistance: {
    color: "#FFFFFF",
    fontSize: 27,
    fontWeight: "700",
  },
  potholeAheadSubtitle: {
    color: "#CBD5E1",
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 4,
  },

  predictionBanner: {
    position: "absolute",
    bottom: 120,
    left: 12,
    right: 12,
    zIndex: 3000,
    elevation: 25,
    backgroundColor: "#172B45",
    borderColor: "#38BDF8",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  predictionBannerTitle: {
    color: "#FFFFFF",
    textAlign: "center",
    fontSize: 16,
    fontWeight: "800",
  },
  predictionBannerInfo: {
    color: "#BAE6FD",
    textAlign: "center",
    fontSize: 12,
    marginTop: 3,
  },
  predictionBannerHint: {
    color: "#CBD5E1",
    textAlign: "center",
    fontSize: 11,
    marginTop: 3,
  },
  detectionToast: {
    position: "absolute",
    top: 75,
    left: 20,
    right: 20,
    zIndex: 1000,
    elevation: 12,
    backgroundColor: "#14532D",
    borderWidth: 1,
    borderColor: "#22C55E",
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },

  detectionToastTitle: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "800",
    textAlign: "center",
  },

  detectionToastSubtitle: {
    color: "#DCFCE7",
    fontSize: 12,
    marginTop: 5,
    textAlign: "center",
  },

  header: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  logo: {
    fontSize: 25,
    fontWeight: "800",
    color: "#F8FAFC",
    letterSpacing: 2,
  },

  subtitle: {
    color: "#94A3B8",
    fontSize: 12,
    marginTop: 2,
  },

  settingsButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: "#1E293B",
    alignItems: "center",
    justifyContent: "center",
  },

  settingsIcon: {
    fontSize: 27,
    lineHeight: 33,
    color: "#F8FAFC",
    textAlign: "center",
    includeFontPadding: false,
  },

  searchPanel: {
    marginHorizontal: 14,
    marginBottom: 10,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: "#1E293B",
  },

  searchRow: {
    minHeight: 49,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },

  sourceDot: {
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: "#38BDF8",
  },

  destinationPin: {
    width: 11,
    height: 11,
    borderRadius: 3,
    backgroundColor: "#F59E0B",
  },

  searchInput: {
    flex: 1,
    color: "#F8FAFC",
    fontSize: 14,
    paddingVertical: 10,
    outlineStyle: "none",
  } as any,

  searchDivider: {
    height: 1,
    backgroundColor: "#334155",
    marginLeft: 23,
  },

  sourceActionButton: {
    backgroundColor: "#334155",
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },

  sourceActionButtonText: {
    color: "#F8FAFC",
    fontWeight: "700",
    fontSize: 12,
  },

  searchButton: {
    backgroundColor: "#0F766E",
    borderRadius: 9,
    paddingHorizontal: 15,
    paddingVertical: 10,
  },

  searchButtonText: {
    color: "#FFFFFF",
    fontWeight: "700",
  },

  destinationResultsPanel: {
    backgroundColor: "#18232F",
    borderRadius: 12,
    marginHorizontal: 16,
    marginTop: 2,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    zIndex: 10,
    elevation: 5,
  },

  destinationResultItem: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#344054",
  },

  destinationResultName: {
    color: "#F8FAFC",
    fontSize: 15,
    fontWeight: "600",
  },

  destinationResultAddress: {
    color: "#A7B3C2",
    fontSize: 12,
    marginTop: 4,
  },

  destinationResultText: {
    color: "#F8FAFC",
    fontSize: 13,
    marginTop: 8,
  },

  attributionText: {
    color: "#A7B3C2",
    fontSize: 10,
    marginTop: 10,
    textAlign: "center",
  },

  mapContainer: {
    flex: 1,
    minHeight: 220,
    marginHorizontal: 10,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "#1E293B",
    position: "relative",
  },

  locationBadge: {
    position: "absolute",
    top: 12,
    left: 12,
    backgroundColor: "#101820",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  locationBadgeText: {
    color: "#F8FAFC",
    fontSize: 12,
  },

  myLocationButton: {
    position: "absolute",
    bottom: 18,
    right: 14,
    width: 46,
    height: 46,
    borderRadius: 15,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },

  locationCrosshair: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  crosshairRing: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2.5,
    borderColor: "#0F766E",
  },
  crosshairCenter: {
    position: "absolute",
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#0F766E",
  },
  crosshairTick: {
    position: "absolute",
    width: 2.5,
    height: 6,
    backgroundColor: "#0F766E",
  },
  crosshairTop: { top: 0 },
  crosshairBottom: { bottom: 0 },
  crosshairTickHorizontal: {
    position: "absolute",
    height: 2.5,
    width: 6,
    backgroundColor: "#0F766E",
  },
  crosshairLeft: { left: 0 },
  crosshairRight: { right: 0 },
  settingsBackdrop: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 22,
    backgroundColor: "rgba(0, 0, 0, 0.68)",
  },
  settingsSheet: {
    maxHeight: "85%",
    backgroundColor: "#1E293B",
    borderRadius: 20,
    padding: 20,
  },
  settingsSheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 22,
  },
  settingsSheetTitle: {
    fontSize: 23,
    fontWeight: "700",
    color: "#F8FAFC",
  },
  settingsCloseButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#334155",
    alignItems: "center",
    justifyContent: "center",
  },
  settingsCloseText: { color: "#F8FAFC", fontSize: 16, fontWeight: "700" },
  settingsOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 18,
    gap: 12,
  },
  settingsOptionDetails: { flex: 1 },
  settingsOptionTitle: { color: "#F8FAFC", fontSize: 16, fontWeight: "600" },
  settingsOptionHint: { color: "#94A3B8", fontSize: 12, marginTop: 4 },
  settingsInfoSection: {
    borderTopWidth: 1,
    borderTopColor: "#334155",
    paddingTop: 16,
    gap: 9,
  },
  settingsInfoHeading: { color: "#F8FAFC", fontWeight: "700", fontSize: 15 },
  settingsInfoText: { color: "#CBD5E1", fontSize: 14 },
  settingsFootnote: { color: "#94A3B8", fontSize: 12, marginTop: 20 },
  pilotSection: {
    borderTopWidth: 1,
    borderTopColor: "#334155",
    paddingTop: 12,
    paddingBottom: 14,
    gap: 9,
  },
  pilotDeviceIdLabel: { color: "#94A3B8", fontSize: 12 },
  pilotDeviceIdValue: { color: "#CBD5E1", fontSize: 11 },
  navDestinationBanner: {
    marginHorizontal: 12,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "#1E293B",
    borderRadius: 12,
  },
  navDestinationText: {
    color: "#F8FAFC",
    fontSize: 15,
    fontWeight: "700",
  },
  speedChip: {
    minWidth: 60,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  speedChipValue: {
    color: "#F8FAFC",
    fontSize: 16,
    fontWeight: "800",
  },
  speedChipUnit: {
    color: "#94A3B8",
    fontSize: 10,
  },
  activeNavigationBar: {
    backgroundColor: "#1E293B",
    borderRadius: 16,
    marginHorizontal: 10,
    marginTop: 10,
    marginBottom: 10,
    padding: 12,
  },
  activeNavigationStats: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginBottom: 10,
  },
  activeNavigationMetric: {
    flex: 1,
    paddingHorizontal: 10,
  },
  activeNavigationLabel: {
    color: "#94A3B8",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
  },
  activeNavigationValue: {
    color: "#F8FAFC",
    fontSize: 27,
    fontWeight: "800",
    marginTop: 2,
  },
  activeNavigationUnit: {
    fontSize: 12,
    fontWeight: "500",
    color: "#CBD5E1",
  },
  quickStopButton: {
    backgroundColor: "#B91C1C",
    minHeight: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  quickStopText: {
    color: "#FFFFFF",
    fontWeight: "800",
    fontSize: 16,
  },

  bottomPanel: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 8,
  },

  anomalyStatus: {
    minHeight: 28,
    paddingHorizontal: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  statusText: {
    color: "#94A3B8",
    fontSize: 11,
  },

  errorText: {
    color: "#F87171",
    fontSize: 11,
    flexShrink: 1,
  },

  rerouteBanner: {
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 11,
    backgroundColor: "#243244",
    borderColor: "#F59E0B",
    borderWidth: 1,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rerouteBannerText: {
    color: "#F8FAFC",
    fontSize: 12,
    fontWeight: "600",
    flexShrink: 1,
  },

  routeCard: {
    padding: 14,
    backgroundColor: "#1E293B",
    borderRadius: 17,
  },

  routeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  routeTitle: {
    fontSize: 15,
    color: "#F8FAFC",
    fontWeight: "700",
  },

  routeBadge: {
    backgroundColor: "#854D0E",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },

  routeBadgeText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#FEF3C7",
  },

  routeStats: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 15,
  },

  routeDistance: {
    fontSize: 19,
    fontWeight: "700",
    color: "#F8FAFC",
  },

  statLabel: {
    color: "#94A3B8",
    fontSize: 11,
    marginTop: 4,
  },

  disclaimer: {
    color: "#FBBF24",
    fontSize: 10,
    marginTop: 12,
    lineHeight: 15,
  },

  emptyRouteText: {
    color: "#94A3B8",
    fontSize: 12,
    marginTop: 12,
    lineHeight: 18,
  },

  navigationButton: {
    height: 47,
    marginTop: 15,
    borderRadius: 12,
    backgroundColor: "#0F766E",
    alignItems: "center",
    justifyContent: "center",
  },

  stopNavigationButton: {
    backgroundColor: "#B91C1C",
  },

  navigationButtonText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 14,
  },
});
