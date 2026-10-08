package com.smsqos.monitor

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.ExistingPeriodicWorkPolicy
import java.util.concurrent.TimeUnit

/**
 * Envoie un heartbeat au backend toutes les ~15 min (minimum autorisé par
 * WorkManager pour du travail périodique) tant que le backend est configuré.
 * Ne fait rien de plus : la mesure QoS reste basée sur les SMS de test, ce
 * heartbeat sert uniquement à distinguer "téléphone/app hors service" de
 * "pas de test récent sur cette route".
 */
class HeartbeatWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        if (!ApiClient.isConfigured(applicationContext)) {
            // Pas encore configuré (première installation) : rien à signaler,
            // on retente au prochain cycle plutôt que d'échouer bruyamment.
            return Result.success()
        }
        val ok = ApiClient.sendHeartbeatSync(applicationContext)
        // Result.retry() déclenche un retry avec backoff exponentiel géré par
        // WorkManager ; un échec réseau ponctuel n'annule pas le prochain
        // battement périodique planifié de toute façon.
        return if (ok) Result.success() else Result.retry()
    }

    companion object {
        private const val WORK_NAME = "sms_qos_heartbeat"

        // Heartbeat immédiat (en plus du cycle de 15 min) : appelé à l'ouverture
        // de l'app pour que le dashboard reflète tout de suite l'état du
        // téléphone et sa boîte de réception, sans attendre le prochain cycle.
        fun runNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<HeartbeatWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueue(request)
        }

        // Enqueue idempotent : rappelable à chaque démarrage de l'app ou du
        // téléphone sans dupliquer le travail planifié (KEEP = ne remplace pas
        // un travail déjà en cours si un existe déjà avec le même nom).
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val request = PeriodicWorkRequestBuilder<HeartbeatWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }
    }
}
