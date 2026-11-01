import React, { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import MapView, {
  Circle,
  Marker,
  Polyline,
  PROVIDER_GOOGLE,
  type Region,
} from "react-native-maps";

type Coordinate = { latitude: number; longitude: number };
type Hazard = Coordinate & {
  id: string;
  intensity: number;
  type: "POTHOLE" | "SPEED_BREAKER";
  confidence: number;
};
type IRADSMapProps = {
  currentLocation: Coordinate | null;
  initialCenter: Coordinate;
  routeSelected: boolean;
  isNavigating?: boolean;
  showHeatmap: boolean;
  route: Coordinate[];
  hazards: Hazard[];
  sourceCoordinate?: Coordinate | null;
  sourceLabel?: string;
  destinationCoordinate?: Coordinate | null;
  destinationLabel?: string;
  pendingMapCoordinate?: Coordinate | null;
  onMapLongPress?: (coordinate: Coordinate) => void;
  recenterRequest?: number;
};

const DEFAULT_LATITUDE_DELTA = 0.055;
const DEFAULT_LONGITUDE_DELTA = 0.055;
const NAVIGATION_LATITUDE_DELTA = 0.008;
const NAVIGATION_LONGITUDE_DELTA = 0.008;

const DARK_MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#17212b" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#a5b4c5" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#17212b" }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#344454" }] },
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#1d2b36" }] },
  { featureType: "poi.park", elementType: "geometry.fill", stylers: [{ color: "#18372f" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#293846" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#3a4b5b" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#435365" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#253440" }] },
  { featureType: "water", elementType: "geometry.fill", stylers: [{ color: "#0c1822" }] },
];

export default function IRADSMap({
  currentLocation,
  initialCenter,
  routeSelected,
  isNavigating = false,
  showHeatmap,
  route,
  hazards,
  sourceCoordinate = null,
  sourceLabel = "Starting point",
  destinationCoordinate = null,
  destinationLabel = "Destination",
  pendingMapCoordinate = null,
  onMapLongPress,
  recenterRequest = 0,
}: IRADSMapProps) {
  const mapRef = useRef<MapView | null>(null);
  const lastRecenterRequest = useRef(recenterRequest);
  const initialRegion: Region = {
    latitude: initialCenter.latitude,
    longitude: initialCenter.longitude,
    latitudeDelta: DEFAULT_LATITUDE_DELTA,
    longitudeDelta: DEFAULT_LONGITUDE_DELTA,
  };

  useEffect(() => {
    if (!routeSelected || route.length < 2 || !mapRef.current) return;
    const fitCoordinates = destinationCoordinate ? [...route, destinationCoordinate] : route;
    const timer = setTimeout(() => {
      mapRef.current?.fitToCoordinates(fitCoordinates, {
        edgePadding: { top: 42, right: 34, bottom: 42, left: 34 },
        animated: true,
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [routeSelected, route, destinationCoordinate]);

  useEffect(() => {
    if (routeSelected || !currentLocation || !mapRef.current || pendingMapCoordinate) return;
    mapRef.current.animateToRegion({
      latitude: currentLocation.latitude,
      longitude: currentLocation.longitude,
      latitudeDelta: DEFAULT_LATITUDE_DELTA,
      longitudeDelta: DEFAULT_LONGITUDE_DELTA,
    }, 300);
  }, [routeSelected, currentLocation?.latitude, currentLocation?.longitude, pendingMapCoordinate]);

  useEffect(() => {
    if (!isNavigating || !currentLocation || !mapRef.current) return;
    mapRef.current.animateToRegion({
      latitude: currentLocation.latitude,
      longitude: currentLocation.longitude,
      latitudeDelta: NAVIGATION_LATITUDE_DELTA,
      longitudeDelta: NAVIGATION_LONGITUDE_DELTA,
    }, 500);
  }, [isNavigating, currentLocation?.latitude, currentLocation?.longitude]);

  useEffect(() => {
    if (lastRecenterRequest.current === recenterRequest) return;
    lastRecenterRequest.current = recenterRequest;
    if (!currentLocation || !mapRef.current) return;
    mapRef.current.animateToRegion({
      latitude: currentLocation.latitude,
      longitude: currentLocation.longitude,
      latitudeDelta: NAVIGATION_LATITUDE_DELTA,
      longitudeDelta: NAVIGATION_LONGITUDE_DELTA,
    }, 500);
  }, [recenterRequest, currentLocation?.latitude, currentLocation?.longitude]);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_GOOGLE}
        initialRegion={initialRegion}
        customMapStyle={DARK_MAP_STYLE}
        toolbarEnabled={false}
        showsUserLocation={false}
        showsMyLocationButton={false}
        loadingEnabled
        onLongPress={(event) => {
          if (isNavigating) return;
          const coordinate = event.nativeEvent.coordinate;
          if (Number.isFinite(coordinate.latitude) && Number.isFinite(coordinate.longitude)) {
            onMapLongPress?.({ latitude: coordinate.latitude, longitude: coordinate.longitude });
          }
        }}
      >
        {currentLocation && (
          <Marker coordinate={currentLocation} title="My current location" description="Live GPS position" anchor={{ x: 0.5, y: 0.5 }} zIndex={3000}>
            <View style={styles.locationOuter}><View style={styles.locationInner} /></View>
          </Marker>
        )}
        {routeSelected && route.length >= 2 && (
          <Polyline coordinates={route} strokeColor="#38BDF8" strokeWidth={5} lineCap="round" lineJoin="round" />
        )}
        {showHeatmap && hazards.map((hazard) => {
          const isPothole = hazard.type === "POTHOLE";
          const color = isPothole ? "#EF4444" : "#F59E0B";
          const confidence = Math.max(0, Math.min(1, Number(hazard.confidence ?? hazard.intensity) || 0));
          return (
            <React.Fragment key={hazard.id}>
              <Circle center={hazard} radius={14 + confidence * 14} strokeColor={color} strokeWidth={2} fillColor={`${color}55`} />
              <Marker coordinate={hazard} title={isPothole ? "Pothole" : "Speed breaker"} description={`Confidence: ${(confidence * 100).toFixed(0)}%`} pinColor={color} tracksViewChanges={false} />
            </React.Fragment>
          );
        })}
        {sourceCoordinate && (
          <Marker coordinate={sourceCoordinate} title={sourceLabel} description="Selected starting location" pinColor="#22C55E" zIndex={1900} tracksViewChanges={false} />
        )}
        {destinationCoordinate && (
          <Marker coordinate={destinationCoordinate} title={destinationLabel} description="Selected destination" pinColor="#EF4444" zIndex={2000} anchor={{ x: 0.5, y: 1 }} tracksViewChanges={false} />
        )}
        {pendingMapCoordinate && (
          <Marker coordinate={pendingMapCoordinate} title="Selected map point" description="Choose Source or Destination" pinColor="#FACC15" zIndex={2500} tracksViewChanges={false} />
        )}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 220, width: "100%", height: "100%" },
  map: { width: "100%", height: "100%", minHeight: 220, backgroundColor: "#17212b" },
  locationOuter: { width: 24, height: 24, borderRadius: 12, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", elevation: 5 },
  locationInner: { width: 16, height: 16, borderRadius: 8, backgroundColor: "#2563EB" },
});
