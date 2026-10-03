package com.smsqos.monitor

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var backendUrlInput: EditText
    private lateinit var apiKeyInput: EditText
    private lateinit var statusText: TextView

    private val requiredPermissions = arrayOf(
        Manifest.permission.RECEIVE_SMS,
        Manifest.permission.READ_SMS
    )

    private val permissionLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        updateStatus()
        if (grants.values.any { !it }) {
            statusText.append("\n\n⚠ Sans la permission SMS, l'app ne peut pas détecter les messages reçus.")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        backendUrlInput = findViewById(R.id.backendUrlInput)
        apiKeyInput = findViewById(R.id.apiKeyInput)
        statusText = findViewById(R.id.statusText)

        backendUrlInput.setText(ApiClient.getBackendUrl(this))
        apiKeyInput.setText(ApiClient.getApiKey(this))

        findViewById<Button>(R.id.saveButton).setOnClickListener {
            val url = backendUrlInput.text.toString()
            val key = apiKeyInput.text.toString()
            ApiClient.saveConfig(this, url, key)
            requestPermissionsIfNeeded()
            requestBatteryOptimizationExemptionIfNeeded()
            HeartbeatWorker.schedule(this)
            updateStatus()
        }

        requestPermissionsIfNeeded()
        requestBatteryOptimizationExemptionIfNeeded()
        // Idempotent (ExistingPeriodicWorkPolicy.KEEP) : sûr à rappeler à
        // chaque ouverture de l'app, y compris si le backend n'est pas encore
        // configuré (le Worker se contente alors de ne rien faire, voir
        // HeartbeatWorker.doWork).
        HeartbeatWorker.schedule(this)
        updateStatus()
    }

    override fun onResume() {
        super.onResume()
        // L'utilisateur peut revenir de l'écran système de confirmation (ou
        // des réglages de batterie) pendant que l'app est en arrière-plan ;
        // on rafraîchit l'état affiché à chaque retour au premier plan.
        updateStatus()
    }

    /**
     * Demande l'exemption de l'optimisation de batterie standard d'Android.
     * Sans elle, le système peut mettre le process en veille (App Standby /
     * Doze) entre deux SMS, ce qui empêche aussi bien SmsReceiver que
     * HeartbeatWorker de s'exécuter tant que l'app n'est pas rouverte — un
     * symptôme observé en pratique : heartbeat ET remontée SMS s'arrêtent
     * ensemble, pas seulement la remontée SMS.
     *
     * Ne couvre PAS les gestionnaires "autostart" propriétaires de certains
     * constructeurs (MIUI, ColorOS, Vivo, Samsung "Sleeping apps"...), qui
     * n'ont pas d'API publique Android et imposent une action manuelle de
     * l'utilisateur dans les réglages du téléphone.
     */
    private fun requestBatteryOptimizationExemptionIfNeeded() {
        val powerManager = getSystemService(PowerManager::class.java)
        if (powerManager != null && !powerManager.isIgnoringBatteryOptimizations(packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            try {
                startActivity(intent)
            } catch (e: Exception) {
                // Certains constructeurs (surtout ceux avec leur propre
                // gestionnaire de batterie) ne fournissent pas cet écran
                // système ; dans ce cas il faudra passer par l'autostart
                // manager du téléphone, signalé dans updateStatus().
            }
        }
    }

    private fun isIgnoringBatteryOptimizations(): Boolean {
        val powerManager = getSystemService(PowerManager::class.java)
        return powerManager?.isIgnoringBatteryOptimizations(packageName) ?: false
    }

    private fun requestPermissionsIfNeeded() {
        val missing = requiredPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    private fun hasSmsPermissions(): Boolean =
        requiredPermissions.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }

    private fun updateStatus() {
        val configured = ApiClient.isConfigured(this)
        val permGranted = hasSmsPermissions()
        val batteryExempt = isIgnoringBatteryOptimizations()
        statusText.text = buildString {
            append("Version app : ${BuildConfig.VERSION_NAME}\n\n")
            append(if (configured) "✓ Backend configuré\n" else "✗ Backend non configuré\n")
            append(if (permGranted) "✓ Permissions SMS accordées\n" else "✗ Permissions SMS manquantes\n")
            append(if (batteryExempt) "✓ Exempté de l'optimisation batterie" else "✗ PAS exempté de l'optimisation batterie")
            if (!batteryExempt) {
                append("\n⚠ Android peut mettre l'app en veille entre deux SMS. Si cette ligne reste à ✗ après avoir accepté la popup, va dans Réglages > Batterie > (cette app) et choisis \"Sans restriction\"/\"Autoriser en arrière-plan\".")
            }
            if (configured && permGranted) {
                append("\n\nPense aussi à vérifier le gestionnaire de démarrage automatique du téléphone (ex: \"Autostart\" sur MIUI/ColorOS/Vivo) : sur certains constructeurs, il faut activer l'app là aussi, en plus de l'exemption batterie ci-dessus — sinon le système peut quand même arrêter l'app silencieusement.")
            }
            if (configured && permGranted && batteryExempt) {
                append(" Ce téléphone est prêt : laisse l'app installée et le téléphone allumé, les SMS reçus seront remontés automatiquement.")
            }
        }
    }
}
