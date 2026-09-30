package com.smsqos.monitor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * WorkManager persiste ses travaux planifiés à travers un redémarrage, mais
 * seulement si quelque chose déclenche son initialisation après le boot (une
 * activité ouverte, ou ce receiver). Sans lui, le heartbeat resterait muet
 * jusqu'à ce qu'on rouvre l'app à la main après chaque redémarrage du
 * téléphone — à éviter vu que ces téléphones sont censés tourner seuls.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            HeartbeatWorker.schedule(context)
        }
    }
}
