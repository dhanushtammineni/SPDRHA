import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import L from "leaflet";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

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

function pinIcon(color: string) {
  return L.divIcon({
    className: "irads-map-pin-wrapper",
    html: `<div style="width:32px;height:32px;position:relative;transform:rotate(-45deg);background:${color};border:2px solid #fff;border-radius:50% 50% 50% 0;box-shadow:0 2px 8px rgba(0,0,0,.45);box-sizing:border-box;display:flex;align-items:center;justify-content:center"><div style="width:9px;height:9px;background:#fff;border-radius:50%"></div></div>`,
    iconSize: [36, 42],
    iconAnchor: [18, 40],
    popupAnchor: [0, -38],
  });
}
const destinationIcon = pinIcon("#ef4444");
const sourceIcon = pinIcon("#22c55e");
const pendingIcon = pinIcon("#facc15");

function ViewportController({
  initialCenter, routeSelected, route, destinationCoordinate, isNavigating, currentLocation, recenterRequest, pendingMapCoordinate,
}: Pick<IRADSMapProps, "initialCenter" | "routeSelected" | "route" | "destinationCoordinate" | "isNavigating" | "currentLocation" | "recenterRequest" | "pendingMapCoordinate">) {
  const map = useMap();
  useEffect(() => {
    if (!routeSelected || route.length < 2) return;
    const bounds = L.latLngBounds(route.map(p => [p.latitude, p.longitude] as [number, number]));
    if (destinationCoordinate) bounds.extend([destinationCoordinate.latitude, destinationCoordinate.longitude]);
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
  }, [map, routeSelected, route, destinationCoordinate]);
  useEffect(() => {
    if (routeSelected || pendingMapCoordinate) return;
    map.setView([initialCenter.latitude, initialCenter.longitude], Math.max(map.getZoom(), 13));
  }, [map, routeSelected, pendingMapCoordinate, initialCenter.latitude, initialCenter.longitude]);
  useEffect(() => {
    if (!isNavigating || !currentLocation) return;
    map.panTo([currentLocation.latitude, currentLocation.longitude], { animate: true });
  }, [map, isNavigating, currentLocation?.latitude, currentLocation?.longitude]);
  useEffect(() => {
    if (!recenterRequest || !currentLocation) return;
    map.setView([currentLocation.latitude, currentLocation.longitude], 16, { animate: true });
  }, [map, recenterRequest]);
  return null;
}

function LongPressPicker({ onPick, disabled }: { onPick?: (coordinate: Coordinate) => void; disabled: boolean }) {
  // Leaflet doesn't have a built-in longpress event. Distinguish a hold from
  // a normal click/drag, and clean up event handlers when the component unmounts.
  const map = useMapEvents({});
  useEffect(() => {
    if (disabled || !onPick) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startedAt: L.Point | null = null;
    const clear = () => { if (timer) clearTimeout(timer); timer = null; startedAt = null; };
    const start = (event: L.LeafletMouseEvent) => {
      clear();
      if (event.originalEvent && "button" in event.originalEvent && (event.originalEvent as MouseEvent).button !== 0) return;
      startedAt = map.mouseEventToContainerPoint(event.originalEvent as MouseEvent);
      const coordinate = { latitude: event.latlng.lat, longitude: event.latlng.lng };
      timer = setTimeout(() => { timer = null; startedAt = null; onPick(coordinate); }, 600);
    };
    const move = (event: L.LeafletMouseEvent) => {
      if (!startedAt) return;
      const now = map.mouseEventToContainerPoint(event.originalEvent as MouseEvent);
      if (now.distanceTo(startedAt) > 12) clear();
    };
    map.on("mousedown", start);
    map.on("mousemove", move);
    map.on("mouseup", clear);
    map.on("dragstart", clear);
    map.on("mouseout", clear);
    return () => {
      clear(); map.off("mousedown", start); map.off("mousemove", move);
      map.off("mouseup", clear); map.off("dragstart", clear); map.off("mouseout", clear);
    };
  }, [map, onPick, disabled]);
  return null;
}

export default function IRADSMap({
  currentLocation, initialCenter, routeSelected, isNavigating = false,
  showHeatmap, route, hazards, sourceCoordinate = null, sourceLabel = "Starting point",
  destinationCoordinate = null, destinationLabel = "Destination",
  pendingMapCoordinate = null, onMapLongPress, recenterRequest = 0,
}: IRADSMapProps) {
  const routeLatLngs = route.map(p => [p.latitude, p.longitude] as [number, number]);
  return (
    <View style={styles.container}>
      <MapContainer center={[initialCenter.latitude, initialCenter.longitude]} zoom={13} scrollWheelZoom style={styles.map}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <ViewportController initialCenter={initialCenter} routeSelected={routeSelected} route={route} destinationCoordinate={destinationCoordinate} isNavigating={isNavigating} currentLocation={currentLocation} recenterRequest={recenterRequest} pendingMapCoordinate={pendingMapCoordinate} />
        <LongPressPicker onPick={onMapLongPress} disabled={isNavigating} />
        {routeSelected && routeLatLngs.length >= 2 && (
          <Polyline positions={routeLatLngs} pathOptions={{ color: "#38bdf8", weight: 5, opacity: 0.95 }} />
        )}
        {currentLocation && (
          <>
            <CircleMarker center={[currentLocation.latitude, currentLocation.longitude]} radius={8} pathOptions={{ color: "#ffffff", weight: 2, fillColor: "#0284c7", fillOpacity: 1 }}><Popup>Your current location</Popup></CircleMarker>
            <CircleMarker center={[currentLocation.latitude, currentLocation.longitude]} radius={16} pathOptions={{ color: "#0284c7", weight: 2, opacity: 0.55, fillOpacity: 0 }} />
          </>
        )}
        {showHeatmap && hazards.map(hazard => {
          const isPothole = hazard.type === "POTHOLE";
          const color = isPothole ? "#ef4444" : "#f59e0b";
          const confidence = Math.max(0, Math.min(1, hazard.confidence || hazard.intensity || 0));
          return (
            <React.Fragment key={hazard.id}>
              <CircleMarker center={[hazard.latitude, hazard.longitude]} radius={10 + confidence * 4} pathOptions={{ color, weight: 2, fillColor: color, fillOpacity: 0.48 }}>
                <Popup><strong>{isPothole ? "Pothole" : "Speed breaker"}</strong><br />Confidence: {(confidence * 100).toFixed(0)}%</Popup>
              </CircleMarker>
              <CircleMarker center={[hazard.latitude, hazard.longitude]} radius={4} pathOptions={{ color: "#ffffff", weight: 1, fillColor: color, fillOpacity: 1 }} />
            </React.Fragment>
          );
        })}
        {sourceCoordinate && (
          <Marker position={[sourceCoordinate.latitude, sourceCoordinate.longitude]} icon={sourceIcon} zIndexOffset={1900}>
            <Popup><strong>Starting location</strong><br />{sourceLabel}</Popup>
          </Marker>
        )}
        {destinationCoordinate && (
          <Marker position={[destinationCoordinate.latitude, destinationCoordinate.longitude]} icon={destinationIcon} zIndexOffset={2000}>
            <Popup><strong>Destination</strong><br />{destinationLabel}</Popup>
          </Marker>
        )}
        {pendingMapCoordinate && (
          <Marker position={[pendingMapCoordinate.latitude, pendingMapCoordinate.longitude]} icon={pendingIcon} zIndexOffset={2500}>
            <Popup>Choose this point as your source or destination.</Popup>
          </Marker>
        )}
      </MapContainer>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 220, width: "100%", height: "100%" },
  map: { width: "100%", height: "100%", minHeight: 220, backgroundColor: "#e5e7eb" },
});
