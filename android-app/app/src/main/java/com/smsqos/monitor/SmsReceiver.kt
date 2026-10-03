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

        // ApiClient.reportReceivedSms envoie l'appel réseau de façon
        // ASYNCHRONE (OkHttp.enqueue) sur un thread séparé. Un
        // BroadcastReceiver système n'est garanti vivant que pendant
        // l'exécution d'onReceive() : dès que cette méthode retourne (donc
        // immédiatement, puisque enqueue() ne bloque pas), Android peut tuer
        // le process de l'app à tout moment — y compris avant que la requête
        // asynchrone n'ait eu le temps de partir ou d'aboutir. Le SMS arrive
        // bien sur le téléphone (le fournisseur confirme la livraison), mais
        // l'app est tuée avant de pouvoir le signaler au serveur. Résultat :
        // un taux de succès qui dépend du hasard (écran allumé, app utilisée
        // récemment...) au lieu d'être fiable — exactement le symptôme
        // observé sur le device Free Mobile (~25% au lieu de 100%).
        //
        // goAsync() demande explicitement à Android de garder le process en
        // vie jusqu'à l'appel à pendingResult.finish(), le temps que la
        // requête réseau se termine vraiment.
        val pendingResult = goAsync()
        ApiClient.reportReceivedSms(context, from, fullBody, receivedAtIso) {
            pendingResult.finish()
        }
    }

    private fun isoNow(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date())
    }
}
