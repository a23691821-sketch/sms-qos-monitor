package com.smsqos.monitor

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
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
            updateStatus()
        }

        requestPermissionsIfNeeded()
        updateStatus()
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
        statusText.text = buildString {
            append(if (configured) "✓ Backend configuré\n" else "✗ Backend non configuré\n")
            append(if (permGranted) "✓ Permissions SMS accordées" else "✗ Permissions SMS manquantes")
            if (configured && permGranted) {
                append("\n\nCe téléphone est prêt : laisse l'app installée et le téléphone allumé, les SMS reçus seront remontés automatiquement.")
            }
        }
    }
}
