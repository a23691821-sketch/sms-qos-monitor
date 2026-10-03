package com.smsqos.monitor

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Stocke la config (URL du backend + clé API du device) et envoie les SMS reçus
 * vers l'endpoint /api/webhook/sms-received.
 */
object ApiClient {

    private const val PREFS = "sms_qos_monitor_prefs"
    private const val KEY_BACKEND_URL = "backend_url"
    private const val KEY_API_KEY = "api_key"
    private const val TAG = "SmsQosMonitor"

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun saveConfig(context: Context, backendUrl: String, apiKey: String) {
        prefs(context).edit()
            .putString(KEY_BACKEND_URL, backendUrl.trim().trimEnd('/'))
            .putString(KEY_API_KEY, apiKey.trim())
            .apply()
    }

    fun getBackendUrl(context: Context): String =
        prefs(context).getString(KEY_BACKEND_URL, "") ?: ""

    fun getApiKey(context: Context): String =
        prefs(context).getString(KEY_API_KEY, "") ?: ""

    fun isConfigured(context: Context): Boolean =
        getBackendUrl(context).isNotBlank() && getApiKey(context).isNotBlank()

    /**
     * Envoie un SMS reçu au backend. Version SYNCHRONE (bloquante), appelée
     * depuis SmsReportWorker — déjà sur un thread d'arrière-plan dédié géré
     * par WorkManager, qui gère lui-même la persistance et les retries (voir
     * SmsReportWorker). Même construction que sendHeartbeatSync ci-dessous.
     *
     * Ancienne version : appel direct, asynchrone (OkHttp.enqueue), depuis
     * SmsReceiver.onReceive() avec goAsync() pour garder le process vivant.
     * Retirée : le budget de temps accordé par goAsync() est court, et le
     * dépasser (ce qui arrivait dès qu'un retry réseau était nécessaire,
     * avec des timeouts de 10s chacun) pouvait rendre Android plus agressif
     * envers l'app ensuite — cassant la réception des SMS suivants. Voir
     * SmsReportWorker pour le détail et la nouvelle approche.
     */
    fun reportReceivedSmsSync(context: Context, from: String?, body: String, receivedAtIso: String): Boolean {
        val backendUrl = getBackendUrl(context)
        val apiKey = getApiKey(context)
        if (backendUrl.isBlank() || apiKey.isBlank()) {
            Log.w(TAG, "Backend non configuré, SMS ignoré")
            return false
        }

        val json = JSONObject().apply {
            put("apiKey", apiKey)
            put("from", from ?: JSONObject.NULL)
            put("body", body)
            put("receivedAt", receivedAtIso)
        }
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val request = Request.Builder()
            .url("$backendUrl/api/webhook/sms-received")
            .post(json.toString().toRequestBody(mediaType))
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                Log.i(TAG, "Webhook envoyé, statut ${response.code}")
                response.isSuccessful
            }
        } catch (e: IOException) {
            Log.e(TAG, "Echec envoi webhook: ${e.message}")
            false
        }
    }

    /**
     * Signal périodique "l'app est vivante", envoyé indépendamment de toute
     * réception de SMS (contrairement à reportReceivedSms ci-dessus). Permet
     * au backend de distinguer "aucun SMS reçu récemment" (peut être normal,
     * ex: route peu fréquente) de "le téléphone/l'app ne répond plus".
     * Version synchrone (bloquante) : appelée depuis un Worker, déjà sur un
     * thread d'arrière-plan dédié — pas besoin de re-enqueue une callback async.
     */
    fun sendHeartbeatSync(context: Context): Boolean {
        val backendUrl = getBackendUrl(context)
        val apiKey = getApiKey(context)
        if (backendUrl.isBlank() || apiKey.isBlank()) {
            Log.w(TAG, "Backend non configuré, heartbeat ignoré")
            return false
        }

        val json = JSONObject().apply { put("apiKey", apiKey) }
        val mediaType = "application/json; charset=utf-8".toMediaType()
        val request = Request.Builder()
            .url("$backendUrl/api/webhook/heartbeat")
            .post(json.toString().toRequestBody(mediaType))
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                Log.i(TAG, "Heartbeat envoyé, statut ${response.code}")
                response.isSuccessful
            }
        } catch (e: IOException) {
            Log.e(TAG, "Echec envoi heartbeat: ${e.message}")
            false
        }
    }

}
