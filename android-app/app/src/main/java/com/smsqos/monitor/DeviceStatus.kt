package com.smsqos.monitor

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.PowerManager
import android.provider.Telephony
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Etat du téléphone + copie de la boîte de réception SMS, joints à chaque
 * heartbeat pour pouvoir diagnostiquer le téléphone à distance (le dashboard
 * affiche batterie, exemption d'optimisation, Doze, réseau, et les derniers
 * SMS reçus — l'équivalent d'ouvrir l'app Messages sans toucher au téléphone).
 *
 * Tout est en "best effort" : une valeur impossible à lire est simplement
 * omise, jamais une exception qui ferait échouer le heartbeat lui-même.
 */
object DeviceStatus {

    private const val TAG = "SmsQosMonitor"
    private const val INBOX_LIMIT = 30
    private const val BODY_MAX_CHARS = 500

    /** Ajoute au JSON du heartbeat les champs d'état et la boîte de réception. */
    fun addTo(context: Context, json: JSONObject) {
        json.put("appVersion", BuildConfig.VERSION_NAME)

        try {
            val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            if (battery != null) {
                val level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                val scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
                if (level >= 0 && scale > 0) json.put("batteryLevel", level * 100 / scale)
                val status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                json.put(
                    "batteryCharging",
                    status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "Lecture batterie impossible: ${e.message}")
        }

        try {
            val pm = context.getSystemService(PowerManager::class.java)
            if (pm != null) {
                json.put("batteryExempt", pm.isIgnoringBatteryOptimizations(context.packageName))
                json.put("dozeMode", pm.isDeviceIdleMode)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Lecture état d'alimentation impossible: ${e.message}")
        }

        json.put("networkType", networkType(context))

        val inbox = readInbox(context)
        if (inbox.length() > 0) json.put("inbox", inbox)
    }

    private fun networkType(context: Context): String {
        return try {
            val cm = context.getSystemService(ConnectivityManager::class.java)
            val caps = cm?.getNetworkCapabilities(cm.activeNetwork)
            when {
                caps == null -> "none"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile"
                else -> "other"
            }
        } catch (e: Exception) {
            "unknown"
        }
    }

    /** Derniers SMS de la boîte de réception (nécessite READ_SMS). */
    private fun readInbox(context: Context): JSONArray {
        val result = JSONArray()
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            return result
        }
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
        try {
            context.contentResolver.query(
                Telephony.Sms.Inbox.CONTENT_URI,
                arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE),
                null,
                null,
                "${Telephony.Sms.DATE} DESC"
            )?.use { cursor ->
                val iAddress = cursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
                val iBody = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
                val iDate = cursor.getColumnIndexOrThrow(Telephony.Sms.DATE)
                while (cursor.moveToNext() && result.length() < INBOX_LIMIT) {
                    val body = cursor.getString(iBody) ?: ""
                    result.put(JSONObject().apply {
                        put("at", fmt.format(Date(cursor.getLong(iDate))))
                        put("from", cursor.getString(iAddress) ?: JSONObject.NULL)
                        put("body", if (body.length > BODY_MAX_CHARS) body.substring(0, BODY_MAX_CHARS) else body)
                    })
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Lecture boîte de réception impossible: ${e.message}")
        }
        return result
    }
}
