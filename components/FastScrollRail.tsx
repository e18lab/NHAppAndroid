import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { StyleSheet, View } from "react-native";

export type FastScrollRailHandle = {
  syncToOffset: (offsetY: number) => void;
};

type Props = {
  viewportHeight: number;
  contentHeight: number;
  accentColor: string;
  railColor: string;
  onSeekRatio: (ratio: number) => void;
  onDragStateChange?: (dragging: boolean) => void;
};

const MIN_THUMB_H = 42;
const MAX_THUMB_H = 110;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

const FastScrollRail = forwardRef<FastScrollRailHandle, Props>(function FastScrollRail(
  {
    viewportHeight,
    contentHeight,
    accentColor,
    railColor,
    onSeekRatio,
    onDragStateChange,
  }: Props,
  ref
) {
  const [dragging, setDragging] = useState(false);
  const [hostHeight, setHostHeight] = useState(0);
  const hostRef = useRef<View | null>(null);
  const thumbRef = useRef<View | null>(null);
  const hostTopRef = useRef(0);
  const hostHeightRef = useRef(0);
  const lastTopRef = useRef(-1);
  const pendingSeekRatioRef = useRef<number | null>(null);
  const seekRafRef = useRef<number | null>(null);

  const { canScroll, thumbHeight, travel } = useMemo(() => {
    const can = contentHeight > viewportHeight + 4 && viewportHeight > 0;
    if (!can) return { canScroll: false, thumbHeight: 0, travel: 0 };
    const effectiveTrackH = hostHeight > 0 ? hostHeight : viewportHeight;
    const trackH = Math.max(40, effectiveTrackH);
    const rawThumb = trackH * (viewportHeight / Math.max(contentHeight, 1));
    const th = clamp(rawThumb, MIN_THUMB_H, MAX_THUMB_H);
    const tr = Math.max(1, trackH - th);
    return { canScroll: true, thumbHeight: th, travel: tr };
  }, [contentHeight, viewportHeight, hostHeight]);

  const updateHostMetrics = () => {
    hostRef.current?.measureInWindow((_, y, _w, h) => {
      hostTopRef.current = Number.isFinite(y) ? y : 0;
      hostHeightRef.current = Number.isFinite(h) ? h : 0;
    });
  };

  useEffect(() => {
    updateHostMetrics();
  }, [viewportHeight]);

  useEffect(() => {
    return () => {
      if (seekRafRef.current != null) {
        cancelAnimationFrame(seekRafRef.current);
        seekRafRef.current = null;
      }
    };
  }, []);

  const setThumbTop = (top: number) => {
    thumbRef.current?.setNativeProps({
      style: {
        top,
      },
    });
  };

  const syncToOffset = (offsetY: number) => {
    if (!canScroll || dragging) return;
    const maxOffset = Math.max(1, contentHeight - viewportHeight);
    const top = clamp((offsetY / maxOffset) * travel, 0, travel);
    if (Math.abs(top - lastTopRef.current) < 0.1) return;
    lastTopRef.current = top;
    setThumbTop(top);
  };

  useImperativeHandle(
    ref,
    () => ({
      syncToOffset,
    }),
    [canScroll, dragging, contentHeight, viewportHeight, travel]
  );

  if (!canScroll) return null;

  const seekByEvent = (e: any) => {
    const pageY = e?.nativeEvent?.pageY;
    const locationY = e?.nativeEvent?.locationY;
    const hostTop = hostTopRef.current;
    const hostH = hostHeightRef.current;
    let localY = Number.isFinite(pageY) ? pageY - hostTop : locationY;
    if (!Number.isFinite(localY)) return;
    if (hostH > 0) {
      localY = clamp(localY, 0, hostH);
    }
    const centered = localY - thumbHeight / 2;
    const ratio = clamp(centered / travel, 0, 1);
    const top = ratio * travel;
    lastTopRef.current = top;
    setThumbTop(top);
    pendingSeekRatioRef.current = ratio;
    if (seekRafRef.current == null) {
      seekRafRef.current = requestAnimationFrame(() => {
        seekRafRef.current = null;
        const next = pendingSeekRatioRef.current;
        pendingSeekRatioRef.current = null;
        if (next == null) return;
        onSeekRatio(next);
      });
    }
  };

  return (
    <View
      ref={hostRef}
      style={s.host}
      onLayout={() => {
        updateHostMetrics();
        const measured = hostHeightRef.current;
        if (Number.isFinite(measured) && measured > 0) {
          setHostHeight(measured);
        }
      }}
    >
      <View
        style={StyleSheet.absoluteFill}
        onStartShouldSetResponderCapture={() => true}
        onMoveShouldSetResponderCapture={() => true}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => {
          updateHostMetrics();
          setDragging(true);
          onDragStateChange?.(true);
          seekByEvent(e);
        }}
        onResponderMove={seekByEvent}
        onResponderRelease={() => {
          setDragging(false);
          onDragStateChange?.(false);
          if (seekRafRef.current != null) {
            cancelAnimationFrame(seekRafRef.current);
            seekRafRef.current = null;
          }
          const pending = pendingSeekRatioRef.current;
          pendingSeekRatioRef.current = null;
          if (pending != null) {
            onSeekRatio(pending);
          }
        }}
        onResponderTerminate={() => {
          setDragging(false);
          onDragStateChange?.(false);
          if (seekRafRef.current != null) {
            cancelAnimationFrame(seekRafRef.current);
            seekRafRef.current = null;
          }
          pendingSeekRatioRef.current = null;
        }}
      />
      <View pointerEvents="none" style={[s.rail, { backgroundColor: railColor }]} />
      <View
        ref={thumbRef}
        pointerEvents="none"
        style={[
          s.thumb,
          {
            height: thumbHeight,
            top: 0,
            backgroundColor: accentColor,
            opacity: dragging ? 0.95 : 0.82,
          },
        ]}
      />
    </View>
  );
});

const s = StyleSheet.create({
  host: {
    position: "absolute",
    right: 0,
    top: 6,
    bottom: 6,
    width: 24,
    alignItems: "center",
    justifyContent: "flex-start",
    zIndex: 40,
    elevation: 40,
  },
  rail: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 6,
    borderRadius: 999,
  },
  thumb: {
    position: "absolute",
    width: 8,
    borderRadius: 999,
  },
});

export default FastScrollRail;
