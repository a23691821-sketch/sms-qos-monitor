package com.smsqos.monitor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Reçoit chaque SMS entrant sur ce téléphone de test. On ne filtre pas sur le
 * contenu ici (le tri "est-ce un test QoS ?" est fait côté backend via le
 * pattern QOS-XXXXXX) pour rester robuste si le format du code évolue.
 */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        if (messages.isNullOrEmpty()) return

        // Un SMS long peut arriver en plusieurs PDU ; on les recolle.
        val from = messages[0].originatingAddress
        val fullBody = messages.joinToString(separator = "") { it.messageBody ?: "" }
        val receivedAtIso = isoNow()

        Log.i("SmsQosMonitor", "SMS reçu de $from: $fullBody")

        // Historique de ce bout de code (pour ne pas réintroduire les mêmes
        // bugs) :
        // 1) Appel réseau direct, asynchrone (OkHttp.enqueue), sans rien
        //    pour garder le process vivant -> le SMS arrivait bien (le
        //    fournisseur confirmait la livraison) mais Android tuait le
        //    process avant que la requête n'aboutisse, dans un cas sur
        //    quatre environ (device Free Mobile).
        // 2) goAsync() + appel réseau avec retries -> corrige le cas 1, mais
        //    le budget de temps accordé par goAsync() est court (quelques
        //    secondes), et le dépasser (ce qui arrivait dès qu'un retry
        //    réseau était nécessaire, timeouts de 10s chacun) rendait
        //    Android plus agressif envers l'app ensuite, cassant carrément
        //    la réception des SMS suivants (observé sur Orange ET Free
        //    juste après le déploiement de ce correctif).
        //
        // Déléguer immédiatement à WorkManager (SmsReportWorker) résout les
        // deux : l'enqueue est une simple écriture en base, quasi instantanée
        // (donc jamais de risque de dépasser un budget de temps), et le
        // travail persisté survit à la mort du process — WorkManager se
        // charge lui-même de l'exécuter (avec retries/backoff) dès que
        // possible, indépendamment du cycle de vie du receiver.
        SmsReportWorker.enqueue(context, from, fullBody, receivedAtIso)
    }

    private fun isoNow(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date())
    }
}
