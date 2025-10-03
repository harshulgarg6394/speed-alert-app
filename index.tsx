import * as Location from "expo-location";
import { LocationSubscription } from 'expo-location';
import {
  Accelerometer,
  DeviceMotion,
  DeviceMotionMeasurement
} from "expo-sensors";
import { useEffect, useRef, useState } from "react";
import { Alert, Platform, StyleSheet, Switch, Text, View } from "react-native";

// --- Define a simple interface for sensor subscriptions if needed for expo-sensors ---
interface SensorSubscription {
  remove(): void;
}

// --- Sensor Update Intervals (in milliseconds) ---
const LOCATION_UPDATE_INTERVAL = 1000; // 1 second
const ACCELEROMETER_UPDATE_INTERVAL = 100; // 100ms for 10Hz sampling
const DEVICEMOTION_UPDATE_INTERVAL = 100; // 100ms for 10Hz sampling

// --- Thresholds ---
const SPEED_DROP_THRESHOLD_KMH = 40; // km/h
const ACCEL_MAGNITUDE_THRESHOLD_G = 3; // G-force
const ACCEL_DURATION_THRESHOLD_MS = 60; // Milliseconds
const TILT_DANGER_THRESHOLD_DEG = 30; // Degrees (for significant instability/potential rollover)

// --- Vehicle Mass (for Momentum Change) ---
const VEHICLE_MASS_KG = 1500; // 🔴 Replace with actual vehicle weight (e.g., from user input)

// --- Combined Alert Logic Thresholds ---
const COMBINED_ALERT_WINDOW_MS = 2000; // All conditions must be met within this time window (2 seconds)
const ALERT_COOLDOWN_MS = 10000; // 10 seconds cooldown between alerts to prevent spam

export default function TabOneScreen() {
  // --- State for UI Display ---
  const [currentSpeed, setCurrentSpeed] = useState<number>(0);
  const [currentAccelerationMagnitude, setCurrentAccelerationMagnitude] =
    useState<number>(0);
  const [currentTiltDegrees, setCurrentTiltDegrees] = useState<number>(0);
  const [momentumChangeDetected, setMomentumChangeDetected] =
    useState<boolean>(false);
  // NEW: State for Latitude and Longitude
  const [currentLatitude, setCurrentLatitude] = useState<number | null>(null);
  const [currentLongitude, setCurrentLongitude] = useState<number | null>(null);

  // --- State for Logic ---
  const lastSpeed = useRef<number | null>(null);
  const lastLocationTimestamp = useRef<number | null>(null);
  const accelPeakTimestamp = useRef<number | null>(null);
  const [alertsEnabled, setAlertsEnabled] = useState(true);

  // --- Flags for Combined Logic ---
  const speedDropDetected = useRef<{ timestamp: number; value: number } | null>(null);
  const highAccelerationDetected = useRef<{ timestamp: number; magnitude: number; duration: number } | null>(null);
  const highTiltDetected = useRef<{ timestamp: number; tilt: number } | null>(null);
  const lastAlertTimestamp = useRef<number>(0); // For alert cooldown

  // NEW: Ref to store last known good coordinates for the alert
  const lastKnownCoordinates = useRef<{ latitude: number; longitude: number } | null>(null);


  // --- Sensor Subscriptions ---
  const locationSubscription = useRef<LocationSubscription | null>(null);
  const accelerometerSubscription = useRef<SensorSubscription | null>(null);
  const deviceMotionSubscription = useRef<SensorSubscription | null>(null);

  // --- Permissions and Sensor Setup ---
  useEffect(() => {
    (async () => {
      // Request Location Permissions
      let { status: locStatus } =
        await Location.requestForegroundPermissionsAsync();
      if (locStatus !== "granted") {
        Alert.alert(
          "Permission Denied",
          "Location permission is required to monitor speed and get coordinates."
        );
        return; // Stop here if location permission denied
      }

      // --- Sensor Permissions and Setup ---
      // Attempt DeviceMotion first for iOS, then fallback to Accelerometer
      // sensorPermissionGranted is not strictly used, but kept for context if needed later
      let sensorPermissionGranted = false;

      if (Platform.OS === "ios" && (await DeviceMotion.isAvailableAsync())) {
        let { status: dmStatus } = await DeviceMotion.requestPermissionsAsync();
        if (dmStatus === "granted") {
          sensorPermissionGranted = true;
          DeviceMotion.setUpdateInterval(DEVICEMOTION_UPDATE_INTERVAL);
          deviceMotionSubscription.current = DeviceMotion.addListener(
            handleDeviceMotion
          );
        } else {
          // DeviceMotion denied, try Accelerometer as fallback on iOS
          Alert.alert(
            "Permission Denied",
            "Device Motion permission denied. Falling back to Accelerometer for impact/tilt detection."
          );
          let { status: accelStatus } = await Accelerometer.requestPermissionsAsync();
          if (accelStatus === "granted") {
            sensorPermissionGranted = true;
            Accelerometer.setUpdateInterval(ACCELEROMETER_UPDATE_INTERVAL);
            accelerometerSubscription.current = Accelerometer.addListener(
              handleAccelerometer
            );
          } else {
            Alert.alert(
              "Permission Denied",
              "Accelerometer permission also denied. Impact and tilt detection will be unavailable."
            );
            // No sensors granted, but we still want location, so don't return here.
          }
        }
      } else {
        // For Android or if DeviceMotion is not available/not iOS
        let { status: accelStatus } = await Accelerometer.requestPermissionsAsync();
        if (accelStatus === "granted") {
          sensorPermissionGranted = true;
          Accelerometer.setUpdateInterval(ACCELEROMETER_UPDATE_INTERVAL);
          accelerometerSubscription.current = Accelerometer.addListener(
            handleAccelerometer
          );
        } else {
          Alert.alert(
            "Permission Denied",
            "Accelerometer permission denied. Impact and tilt detection will be unavailable."
          );
          // No sensors granted, but we still want location, so don't return here.
        }
      }

      // --- Location Listener ---
      // This should run if location permission was granted, regardless of sensor permissions
      locationSubscription.current =
        await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: LOCATION_UPDATE_INTERVAL,
            distanceInterval: 0,
          },
          handleLocationChange
        );

      // --- Cleanup Function ---
      return () => {
        locationSubscription.current?.remove();
        accelerometerSubscription.current?.remove();
        deviceMotionSubscription.current?.remove();
      };
    })();
  }, []); // Run once on component mount

  // --- Event Handlers ---

  const handleLocationChange = (loc: Location.LocationObject) => {
    let speedKmh = (loc.coords.speed || 0) * 3.6; // m/s to km/h
    setCurrentSpeed(speedKmh);
    // NEW: Update Latitude and Longitude
    setCurrentLatitude(loc.coords.latitude);
    setCurrentLongitude(loc.coords.longitude);
    // NEW: Store last known coordinates for alert
    if (loc.coords.latitude && loc.coords.longitude) {
      lastKnownCoordinates.current = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
      };
    }


    let now = Date.now();

    if (lastSpeed.current !== null && lastLocationTimestamp.current !== null) {
      let timeDiff = (now - lastLocationTimestamp.current) / 1000; // seconds
      let speedDrop = lastSpeed.current - speedKmh; // positive if speed decreased

      // --- Speed Drop Detection (Individual Check) ---
      if (
        timeDiff <= 1 &&
        speedDrop >= SPEED_DROP_THRESHOLD_KMH &&
        lastSpeed.current > 5
      ) {
        speedDropDetected.current = { timestamp: now, value: speedDrop };
        setMomentumChangeDetected(true);
        checkCombinedConditions();
      } else if (speedDropDetected.current && (now - speedDropDetected.current.timestamp > COMBINED_ALERT_WINDOW_MS)) {
         speedDropDetected.current = null;
         setMomentumChangeDetected(false); // Reset momentum change if conditions expire
      } else {
         // This else block can cause the momentum change to flash.
         // Consider adding a setTimeout to clear momentumChangeDetected after a delay
         // if you want it to persist for a bit longer on the UI.
         setMomentumChangeDetected(false);
      }
    }

    lastSpeed.current = speedKmh;
    lastLocationTimestamp.current = now;
  };

  const handleAccelerometer = ({ x, y, z }: { x: number; y: number; z: number }) => {
    const magnitudeG = Math.sqrt(x * x + y * y + z * z);
    setCurrentAccelerationMagnitude(magnitudeG);

    let now = Date.now();

    if (magnitudeG >= ACCEL_MAGNITUDE_THRESHOLD_G) {
      if (accelPeakTimestamp.current === null) {
        accelPeakTimestamp.current = now;
      } else if (now - accelPeakTimestamp.current >= ACCEL_DURATION_THRESHOLD_MS) {
        highAccelerationDetected.current = {
          timestamp: now,
          magnitude: magnitudeG,
          duration: now - accelPeakTimestamp.current,
        };
        checkCombinedConditions();
      }
    } else {
      accelPeakTimestamp.current = null;
      if (highAccelerationDetected.current && (now - highAccelerationDetected.current.timestamp > COMBINED_ALERT_WINDOW_MS)) {
        highAccelerationDetected.current = null;
      }
    }

    // Calculating pitch and roll for tilt from accelerometer data
    const pitch = -Math.atan2(y, Math.sqrt(x * x + z * z));
    const roll = Math.atan2(x, Math.sqrt(y * y + z * z));
    const tilt = Math.max(Math.abs(pitch), Math.abs(roll)) * (180 / Math.PI);
    setCurrentTiltDegrees(tilt);

    if (tilt >= TILT_DANGER_THRESHOLD_DEG) {
        highTiltDetected.current = { timestamp: now, tilt: tilt };
        checkCombinedConditions();
    } else if (highTiltDetected.current && (now - highTiltDetected.current.timestamp > COMBINED_ALERT_WINDOW_MS)) {
        highTiltDetected.current = null;
    }
  };

  const handleDeviceMotion = (motion: DeviceMotionMeasurement) => {
    let now = Date.now();

    // Use accelerationIncludingGravity for more accurate motion detection
    // and to derive tilt reliably, similar to accelerometer.
    let acceleration = motion.accelerationIncludingGravity || motion.acceleration;

    if (acceleration) {
      const { x, y, z } = acceleration;
      const magnitudeG = Math.sqrt(x * x + y * y + z * z);
      setCurrentAccelerationMagnitude(magnitudeG);

      if (magnitudeG >= ACCEL_MAGNITUDE_THRESHOLD_G) {
        if (accelPeakTimestamp.current === null) {
          accelPeakTimestamp.current = now;
        } else if (now - accelPeakTimestamp.current >= ACCEL_DURATION_THRESHOLD_MS) {
          highAccelerationDetected.current = {
            timestamp: now,
            magnitude: magnitudeG,
            duration: now - accelPeakTimestamp.current,
          };
          checkCombinedConditions();
        }
      } else {
        accelPeakTimestamp.current = null;
        if (highAccelerationDetected.current && (now - highAccelerationDetected.current.timestamp > COMBINED_ALERT_WINDOW_MS)) {
          highAccelerationDetected.current = null;
        }
      }

      // Calculate tilt from accelerationIncludingGravity
      const pitch = -Math.atan2(y, Math.sqrt(x * x + z * z));
      const roll = Math.atan2(x, Math.sqrt(y * y + z * z));
      const tilt = Math.max(Math.abs(pitch), Math.abs(roll)) * (180 / Math.PI);
      setCurrentTiltDegrees(tilt);

      if (tilt >= TILT_DANGER_THRESHOLD_DEG) {
          highTiltDetected.current = { timestamp: now, tilt: tilt };
          checkCombinedConditions();
      } else if (highTiltDetected.current && (now - highTiltDetected.current.timestamp > COMBINED_ALERT_WINDOW_MS)) {
          highTiltDetected.current = null;
      }
    }
    // Removed the separate motion.rotation block as accelerationIncludingGravity is usually sufficient for tilt
    // and rotation (angular velocity) might be interpreted differently.
  };

  // --- Combined Conditions Check ---
  const checkCombinedConditions = () => {
    const now = Date.now();

    const isSpeedDropActive = speedDropDetected.current && (now - speedDropDetected.current.timestamp < COMBINED_ALERT_WINDOW_MS);
    const isHighAccelerationActive = highAccelerationDetected.current && (now - highAccelerationDetected.current.timestamp < COMBINED_ALERT_WINDOW_MS);
    const isHighTiltActive = highTiltDetected.current && (now - highTiltDetected.current.timestamp < COMBINED_ALERT_WINDOW_MS);

    if (isSpeedDropActive && isHighAccelerationActive && isHighTiltActive) {
      // All three conditions met within the time window!
      // NEW: Pass current coordinates to triggerAlert
      triggerAlert("Combined", {
        latitude: lastKnownCoordinates.current?.latitude,
        longitude: lastKnownCoordinates.current?.longitude,
      });

      // Reset flags to prevent immediate re-triggering for the same event
      speedDropDetected.current = null;
      highAccelerationDetected.current = null;
      highTiltDetected.current = null;
    }
  };

  // --- Alert Triggering Function ---
  const triggerAlert = async (
    type: "SpeedDrop" | "HighAcceleration" | "HighTilt" | "Combined",
    data?: { latitude?: number | null; longitude?: number | null; speedKmh?: number; speedDrop?: number; magnitudeG?: number; duration?: number; tilt?: number; }
  ) => {
    const now = Date.now();
    if (!alertsEnabled || (now - lastAlertTimestamp.current < ALERT_COOLDOWN_MS)) {
      console.log(`Alert (disabled or on cooldown): ${type}`, data);
      return;
    }

    lastAlertTimestamp.current = now;

    let message = "⚠️ Potential Incident Detected!";
    let coordinatesString = "";
    if (data?.latitude != null && data?.longitude != null) {
      coordinatesString = `\nLocation: https://www.google.com/maps/search/?api=1&query=${data.latitude.toFixed(6)},${data.longitude.toFixed(6)}`;
    }

    switch (type) {
      case "SpeedDrop":
        message = `⚠️ Sudden speed drop detected! Speed: ${data?.speedKmh?.toFixed(2) || 'N/A'} km/h, Drop: ${data?.speedDrop?.toFixed(2) || 'N/A'} km/h.${coordinatesString}`;
        break;
      case "HighAcceleration":
        message = `💥 High G-force detected! Magnitude: ${data?.magnitudeG?.toFixed(2) || 'N/A'}g, Duration: ${data?.duration}ms.${coordinatesString}`;
        break;
      case "HighTilt":
        message = `🚨 Critical tilt detected! Angle: ${data?.tilt?.toFixed(2) || 'N/A'}°.${coordinatesString}`;
        break;
      case "Combined":
        message = `🚨🚨🚨 CRITICAL INCIDENT DETECTED!
        \n- Speed Drop: ${speedDropDetected.current?.value.toFixed(2) || 'N/A'} km/h
        \n- Acceleration: ${highAccelerationDetected.current?.magnitude.toFixed(2) || 'N/A'}g
        \n- Tilt: ${highTiltDetected.current?.tilt.toFixed(1) || 'N/A'}°
        ${coordinatesString}
        \nSending SMS...`;
        break;
    }

    console.log("Sending Alert:", message);
    Alert.alert("🚨 Accident Detected!", message);

    try {
      await fetch("http://YOUR_BACKEND_IP:3000/send-alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: "+91xxxxxxxx", // 🔴 Replace with the actual recipient phone number
          message: message,
          // NEW: Also send coordinates in the JSON body
          latitude: data?.latitude,
          longitude: data?.longitude,
        }),
      });
    } catch (err: any) {
      Alert.alert(
        "Error Sending SMS",
        err.message || "Failed to send SMS notification."
      );
    }
  };

  // --- UI Render ---
  return (
    <View style={styles.container}>
      <Text style={styles.title}>🚗 Advanced Vehicle Monitor</Text>

      <View style={styles.dataRow}>
        <Text style={styles.dataLabel}>Current Speed:</Text>
        <Text style={styles.dataValue}>{currentSpeed.toFixed(2)} km/h</Text>
      </View>

      <View style={styles.dataRow}>
        <Text style={styles.dataLabel}>Acceleration Magnitude:</Text>
        <Text style={styles.dataValue}>
          {currentAccelerationMagnitude.toFixed(2)} g
        </Text>
      </View>

      <View style={styles.dataRow}>
        <Text style={styles.dataLabel}>Vehicle Tilt:</Text>
        <Text style={styles.dataValue}>{currentTiltDegrees.toFixed(1)}°</Text>
      </View>

      {/* NEW: Display Latitude and Longitude */}
      <View style={styles.dataRow}>
        <Text style={styles.dataLabel}>Latitude:</Text>
        <Text style={styles.dataValue}>
          {currentLatitude != null ? currentLatitude.toFixed(6) : "N/A"}
        </Text>
      </View>
      <View style={styles.dataRow}>
        <Text style={styles.dataLabel}>Longitude:</Text>
        <Text style={styles.dataValue}>
          {currentLongitude != null ? currentLongitude.toFixed(6) : "N/A"}
        </Text>
      </View>


      {momentumChangeDetected && (
        <Text style={styles.alertText}>
          Momentum Change: {
             speedDropDetected.current ?
             (VEHICLE_MASS_KG * (speedDropDetected.current.value / 3.6)).toFixed(2)
             : 'N/A'
          } kg·m/s
        </Text>
      )}

      <View style={styles.toggleContainer}>
        <Text style={styles.toggleLabel}>SMS Alerts Enabled:</Text>
        <Switch
          onValueChange={() => setAlertsEnabled((prev) => !prev)}
          value={alertsEnabled}
        />
      </View>

      <Text style={styles.footer}>
        Monitoring multiple sensors in real-time.
        {"\n"}Calibration needed for accurate thresholds.
      </Text>
    </View>
  );
}

// --- Styles ---
const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#282c34", // Dark background
    padding: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    marginBottom: 30,
    color: "#61dafb", // Expo/React Native blue
    textAlign: "center",
  },
  dataRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "90%",
    marginBottom: 15,
    padding: 10,
    backgroundColor: "#3a404b", // Slightly lighter dark
    borderRadius: 8,
  },
  dataLabel: {
    fontSize: 18,
    color: "#f8f9fa", // Light text
    fontWeight: "500",
  },
  dataValue: {
    fontSize: 18,
    color: "#e0e0e0", // Lighter grey
    fontWeight: "bold",
  },
  alertText: {
    fontSize: 16,
    color: "#ffc107", // Yellow for warning
    marginTop: 10,
    marginBottom: 20,
    fontWeight: "bold",
    textAlign: "center",
  },
  toggleContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 30,
    padding: 10,
    backgroundColor: "#3a404b",
    borderRadius: 8,
    width: "90%",
    justifyContent: "space-between",
  },
  toggleLabel: {
    fontSize: 16,
    color: "#f8f9fa",
    marginRight: 10,
  },
  footer: {
    fontSize: 12,
    color: "#adb5bd", // Muted grey
    marginTop: 40,
    textAlign: "center",
  },
});

