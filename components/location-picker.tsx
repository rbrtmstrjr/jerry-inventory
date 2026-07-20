"use client";

import * as React from "react";
import type { Map as LeafletMap, Marker } from "leaflet";
import { LocateFixed, MapPinOff } from "lucide-react";
import { toast } from "sonner";
import "leaflet/dist/leaflet.css";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export interface LatLng {
  lat: number;
  lng: number;
}

// Cebu as a sensible starting view when no pin exists yet
const DEFAULT_CENTER: LatLng = { lat: 10.3157, lng: 123.8854 };

/** Themed SVG pin (avoids Leaflet's bundler-broken default icon assets).
 *  Fill is a CSS color/token expression — divIcon HTML lives in the DOM, so
 *  var(--…) resolves against the theme (shop pins pass their palette token). */
const pinSvg = (fill: string) => `
<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">
  <path d="M15 0C6.7 0 0 6.7 0 15c0 11 15 27 15 27s15-16 15-27C30 6.7 23.3 0 15 0z" fill="${fill}"/>
  <circle cx="15" cy="15" r="6" fill="var(--background)"/>
</svg>`;
const PIN_SVG = pinSvg("var(--primary)");

/**
 * Small read-only map preview with a pin — clicking opens Google Maps.
 * Used on shop cards.
 */
export function MapPreview({
  lat,
  lng,
  label,
  className,
  pinColor,
}: {
  lat: number;
  lng: number;
  label: string;
  className?: string;
  /** CSS color expression (a theme token like `var(--shop-teal-strong)`). */
  pinColor?: string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<LeafletMap | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current || mapRef.current) return;

      const map = L.map(containerRef.current, {
        center: [lat, lng],
        zoom: 15,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        touchZoom: false,
        zoomControl: false,
        attributionControl: true,
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OSM",
      }).addTo(map);
      L.marker([lat, lng], {
        icon: L.divIcon({
          html: pinColor ? pinSvg(pinColor) : PIN_SVG,
          className: "",
          iconSize: [30, 42],
          iconAnchor: [15, 42],
        }),
        interactive: false,
      }).addTo(map);

      mapRef.current = map;
      setTimeout(() => map.invalidateSize(), 100);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [lat, lng]);

  return (
    // `isolate` traps Leaflet's high internal z-indexes so dropdowns/popovers
    // elsewhere on the page stay above the map
    <div className={cn("relative isolate overflow-hidden rounded-md border", className)}>
      <div ref={containerRef} className="size-full" aria-hidden />
      {/* click-through to Google Maps, above all leaflet panes */}
      <a
        href={`https://www.google.com/maps?q=${lat},${lng}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${label} in Google Maps`}
        title="Open in Google Maps"
        className="absolute inset-0 z-[500]"
      />
    </div>
  );
}

/**
 * Click-to-pin map (Leaflet + OpenStreetMap, no API key). Click sets the pin,
 * the pin is draggable, geolocation jumps to the user's position.
 */
export function LocationPicker({
  value,
  onChange,
}: {
  value: LatLng | null;
  onChange: (v: LatLng | null) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<LeafletMap | null>(null);
  const markerRef = React.useRef<Marker | null>(null);
  // Keep a ref to the latest onChange so the once-only map-init effect can call
  // it without re-subscribing. Assigned in an effect, not during render — a ref
  // write during render is the react-hooks/refs anti-pattern.
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  });
  const [ready, setReady] = React.useState(false);
  const [locating, setLocating] = React.useState(false);

  // init map once (leaflet touches window — import client-side only)
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current || mapRef.current) return;

      const center = value ?? DEFAULT_CENTER;
      const map = L.map(containerRef.current, {
        center: [center.lat, center.lng],
        zoom: value ? 15 : 11,
        attributionControl: true,
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors",
      }).addTo(map);

      const icon = L.divIcon({
        html: PIN_SVG,
        className: "", // no default styles
        iconSize: [30, 42],
        iconAnchor: [15, 42],
      });

      const setPin = (lat: number, lng: number) => {
        if (markerRef.current) {
          markerRef.current.setLatLng([lat, lng]);
        } else {
          markerRef.current = L.marker([lat, lng], { icon, draggable: true })
            .addTo(map)
            .on("dragend", () => {
              const p = markerRef.current!.getLatLng();
              onChangeRef.current({ lat: p.lat, lng: p.lng });
            });
        }
        onChangeRef.current({ lat, lng });
      };

      map.on("click", (e) => setPin(e.latlng.lat, e.latlng.lng));
      if (value) setPin(value.lat, value.lng);

      mapRef.current = map;
      setReady(true);
      // dialogs animate open — retime the size calc
      setTimeout(() => map.invalidateSize(), 150);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // external clear (value set to null while marker exists)
  React.useEffect(() => {
    if (value === null && markerRef.current) {
      markerRef.current.remove();
      markerRef.current = null;
    }
  }, [value]);

  function useMyLocation() {
    if (!navigator.geolocation) {
      toast.error("This browser has no location support.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setLocating(false);
        const { latitude: lat, longitude: lng } = pos.coords;
        const L = (await import("leaflet")).default;
        const map = mapRef.current;
        if (!map) return;
        map.setView([lat, lng], 16);
        if (markerRef.current) {
          markerRef.current.setLatLng([lat, lng]);
        } else {
          const icon = L.divIcon({
            html: PIN_SVG,
            className: "",
            iconSize: [30, 42],
            iconAnchor: [15, 42],
          });
          markerRef.current = L.marker([lat, lng], { icon, draggable: true })
            .addTo(map)
            .on("dragend", () => {
              const p = markerRef.current!.getLatLng();
              onChangeRef.current({ lat: p.lat, lng: p.lng });
            });
        }
        onChangeRef.current({ lat, lng });
      },
      () => {
        setLocating(false);
        toast.error("Couldn't get your location — allow location access and retry.");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative isolate">
        <div
          ref={containerRef}
          className="h-56 w-full overflow-hidden rounded-md border"
          aria-label="Map — click to place the shop pin"
        />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-muted">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={useMyLocation}
          disabled={locating}
        >
          {locating ? (
            <Spinner className="size-4" />
          ) : (
            <LocateFixed className="size-4" />
          )}
          Use my location
        </Button>
        {value && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(null)}
            >
              <MapPinOff className="size-4" /> Remove pin
            </Button>
            <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
              {value.lat.toFixed(5)}, {value.lng.toFixed(5)}
            </span>
          </>
        )}
        {!value && (
          <span className="text-xs text-muted-foreground">
            Click the map to drop a pin (optional).
          </span>
        )}
      </div>
    </div>
  );
}
