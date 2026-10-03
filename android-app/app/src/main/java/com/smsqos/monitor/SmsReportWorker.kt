package com.smsqos.monitor

import android.content.Context
import androidx.work.Data
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager

/**
 * Signale au backend un SMS reçu, en tâche de fond gérée par WorkManager
 * plutôt que directement depuis SmsReceiver.onReceive().
 *
 * Avant ce correctif, SmsReceiver appelait ApiClient.reportReceivedSms en
 * gardant le process vivant via goAsync() le temps de l'appel réseau (avec
 * jusqu'à 2 retries, chacun avec des timeouts de 10s). Mais le budget
 * accordé par goAsync() est court (quelques secondes, bien en-deçà de 10s
 * en pratique) : dès que la requête traînait un peu (réseau lent, un seul
 * retry nécessaire...), on dépassait ce budget. Dépasser le budget de
 * goAsync() n'est pas juste "la requête s'arrête" — Android peut considérer
 * le receiver comme fautif et devenir plus agressif avec l'app ensuite,
 * jusqu'à casser la réception des SMS suivants. C'est exactement ce qui a
 * été observé : les deux téléphones passés sur la nouvelle version se sont
 * arrêtés de remonter des SMS peu après, alors que les deux restés sur
 * l'ancienne version (sans goAsync) continuaient normalement.
 *
 * WorkManager est le mécanisme recommandé par Android pour ce cas précis :
 * le travail est persisté en base dès l'enqueue (une écriture locale, pas un
 * appel réseau) puis exécuté par le système indépendamment du cycle de vie
 * du BroadcastReceiver — il survit même si le process est tué juste après.
 * SmsReceiver n'a donc plus qu'à enqueue ce Worker et peut se terminer
 * immédiatement, sans dépendre d'aucun budget de temps serré.
 */
class SmsReportWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val from = inputData.getString(KEY_FROM)
        val body = inputData.getString(KEY_BODY) ?: return Result.failure()
        val receivedAt = inputData.getString(KEY_RECEIVED_AT) ?: return Result.failure()

        val ok = ApiClient.reportReceivedSmsSync(applicationContext, from, body, receivedAt)
        // Result.retry() réutilise le backoff exponentiel de WorkManager : un
        // échec réseau ponctuel sera retenté automatiquement plus tard, sans
        // bloquer ni le receiver ni risquer un dépassement de budget.
        return if (ok) Result.success() else Result.retry()
    }

    companion object {
        const val KEY_FROM = "from"
        const val KEY_BODY = "body"
        const val KEY_RECEIVED_AT = "receivedAt"

        fun enqueue(context: Context, from: String?, body: String, receivedAtIso: String) {
            val data = Data.Builder()
                .putString(KEY_FROM, from)
                .putString(KEY_BODY, body)
                .putString(KEY_RECEIVED_AT, receivedAtIso)
                .build()

            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val request = OneTimeWorkRequestBuilder<SmsReportWorker>()
                .setInputData(data)
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(context).enqueue(request)
        }
    }
}
