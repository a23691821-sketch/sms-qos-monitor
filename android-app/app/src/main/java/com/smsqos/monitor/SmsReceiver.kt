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

        ApiClient.reportReceivedSms(context, from, fullBody, receivedAtIso)
    }

    private fun isoNow(): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date())
    }
}
