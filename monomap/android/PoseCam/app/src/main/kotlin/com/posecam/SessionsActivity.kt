package com.posecam

import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Manages raw recordings and exported packages.
 * Clearly displays on-disk storage locations and allows 1-tap export to public Downloads.
 */
class SessionsActivity : Activity() {

    enum class Tab { RAW_CAPTURES, EXPORTED_FILES }

    data class SessionItem(
        val title: String,
        val subtitle: String,
        val sizeStr: String,
        val pathStr: String,
        val rawDir: File? = null,
        val exportFile: File? = null,
        val mediaUri: Uri? = null,
    )

    private companion object {
        const val PREF_ROTATION = "export_rotation_degrees"
    }

    private lateinit var captures: File
    private var currentTab = Tab.RAW_CAPTURES
    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var items: List<SessionItem> = emptyList()

    private lateinit var headerView: TextView
    private lateinit var emptyView: TextView
    private lateinit var listView: ListView
    private lateinit var tabRawBtn: Button
    private lateinit var tabExportsBtn: Button
    private lateinit var tabSubnote: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_sessions)

        captures = File(getExternalFilesDir(null), "captures")
        if (!captures.exists()) captures.mkdirs()

        headerView = findViewById(R.id.header)
        emptyView = findViewById(R.id.empty)
        listView = findViewById(R.id.list)
        tabRawBtn = findViewById(R.id.tab_raw_btn)
        tabExportsBtn = findViewById(R.id.tab_exports_btn)
        tabSubnote = findViewById(R.id.tab_subnote)

        findViewById<Button>(R.id.btn_back).setOnClickListener { finish() }
        findViewById<Button>(R.id.btn_pc_guide).setOnClickListener { showPcGuide() }
        findViewById<Button>(R.id.btn_open_downloads).setOnClickListener { openDownloadsFolder() }

        findViewById<Button>(R.id.btn_copy_path).setOnClickListener {
            copyToClipboard("Captures Path", captures.absolutePath)
        }

        val publicDownloadDir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PoseCam")
        findViewById<Button>(R.id.btn_copy_export_path).setOnClickListener {
            copyToClipboard("Downloads Path", publicDownloadDir.absolutePath)
        }

        tabRawBtn.setOnClickListener {
            currentTab = Tab.RAW_CAPTURES
            updateTabButtons()
            refresh()
        }

        tabExportsBtn.setOnClickListener {
            currentTab = Tab.EXPORTED_FILES
            updateTabButtons()
            refresh()
        }

        listView.setOnItemClickListener { _, _, position, _ ->
            if (position in items.indices) {
                val item = items[position]
                if (currentTab == Tab.RAW_CAPTURES) {
                    showRawSessionActions(item)
                } else {
                    showExportFileActions(item)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        updateTabButtons()
        refresh()
    }

    private fun updateTabButtons() {
        if (currentTab == Tab.RAW_CAPTURES) {
            tabRawBtn.setBackgroundResource(R.drawable.tab_selected)
            tabRawBtn.setTextColor(0xFF0B0F19.toInt())
            tabExportsBtn.setBackgroundResource(R.drawable.tab_unselected)
            tabExportsBtn.setTextColor(0xFF94A3B8.toInt())
            tabSubnote.text = "Tap any raw recording below to save to public Downloads or share."
        } else {
            tabRawBtn.setBackgroundResource(R.drawable.tab_unselected)
            tabRawBtn.setTextColor(0xFF94A3B8.toInt())
            tabExportsBtn.setBackgroundResource(R.drawable.tab_selected)
            tabExportsBtn.setTextColor(0xFF0B0F19.toInt())
            tabSubnote.text = "Exported ZIP packages in Downloads/PoseCam/ ready for PC transfer."
        }
    }

    private fun refresh() {
        val free = (captures.parentFile?.usableSpace ?: 0L) / 1e9
        val used = SessionZipper.sizeOf(captures) / 1e9

        val pubExportDir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PoseCam")
        headerView.text = buildString {
            append("📍 Raw Captures: ${captures.path}\n")
            append("📥 Public Exports: ${pubExportDir.path}\n")
            append("💾 Free Storage: %.1f GB available  ·  %.1f GB used by captures".format(free, used))
        }

        if (currentTab == Tab.RAW_CAPTURES) {
            loadRawSessions()
        } else {
            loadExportedFiles()
        }
    }

    private fun loadRawSessions() {
        val dirs = captures.listFiles { f -> f.isDirectory }?.sortedByDescending { it.name } ?: emptyList()
        tabRawBtn.text = "📼 Raw Captures (${dirs.size})"

        items = dirs.map { dir ->
            val manifest = File(dir, "manifest.json").takeIf { it.exists() }?.readText() ?: ""
            val frames = Regex("\"frame_count\": (\\d+)").find(manifest)?.groupValues?.get(1)?.toLongOrNull()
            val fps = Regex("\"measured_fps\": ([0-9.]+)").find(manifest)?.groupValues?.get(1)?.toDoubleOrNull()
            val complete = manifest.contains("\"complete\": true")
            val jumps = Regex("\"pose_jumps\": \\{\\s*\"count\": (\\d+)").find(manifest)?.groupValues?.get(1)?.toIntOrNull() ?: 0
            val seconds = if (frames != null && fps != null && fps > 0) frames / fps else null
            val sizeMb = SessionZipper.sizeOf(dir) / 1e6

            val sub = buildString {
                if (seconds != null) append("%.0fs  •  ".format(seconds))
                if (frames != null) append("$frames frames  •  ")
                if (fps != null && fps > 0) append("%.1f FPS  •  ".format(fps))
                append(if (jumps == 0) "🟢 0 jumps" else "⚠️ $jumps jump(s)")
                if (!complete) append(" (INCOMPLETE)")
            }

            SessionItem(
                title = dir.name,
                subtitle = sub,
                sizeStr = "%.1f MB".format(sizeMb),
                pathStr = dir.absolutePath,
                rawDir = dir,
            )
        }

        renderList(getString(R.string.no_recordings, captures.path))
    }

    private fun loadExportedFiles() {
        val found = mutableListOf<SessionItem>()
        val pubDir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PoseCam")
        val sdf = SimpleDateFormat("MMM dd, yyyy HH:mm", Locale.getDefault())

        if (pubDir.exists() && pubDir.isDirectory) {
            pubDir.listFiles { f -> f.extension.equals("zip", ignoreCase = true) }?.forEach { f ->
                val sizeMb = f.length() / 1e6
                val dateStr = sdf.format(Date(f.lastModified()))
                found.add(
                    SessionItem(
                        title = f.name,
                        subtitle = "$dateStr  •  Ready for USB/PC",
                        sizeStr = "%.1f MB".format(sizeMb),
                        pathStr = f.absolutePath,
                        exportFile = f,
                    )
                )
            }
        }

        // Also query MediaStore on Android 10+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val projection = arrayOf(
                MediaStore.Downloads._ID,
                MediaStore.Downloads.DISPLAY_NAME,
                MediaStore.Downloads.SIZE,
                MediaStore.Downloads.DATE_MODIFIED
            )
            val selection = "${MediaStore.Downloads.DISPLAY_NAME} LIKE ?"
            val selectionArgs = arrayOf("%.zip")
            try {
                contentResolver.query(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    projection,
                    selection,
                    selectionArgs,
                    "${MediaStore.Downloads.DATE_MODIFIED} DESC"
                )?.use { cursor ->
                    val idCol = cursor.getColumnIndexOrThrow(MediaStore.Downloads._ID)
                    val nameCol = cursor.getColumnIndexOrThrow(MediaStore.Downloads.DISPLAY_NAME)
                    val sizeCol = cursor.getColumnIndexOrThrow(MediaStore.Downloads.SIZE)
                    val dateCol = cursor.getColumnIndexOrThrow(MediaStore.Downloads.DATE_MODIFIED)
                    while (cursor.moveToNext()) {
                        val name = cursor.getString(nameCol)
                        if (name.startsWith("capture-") && found.none { it.title == name }) {
                            val id = cursor.getLong(idCol)
                            val uri = ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id)
                            val size = cursor.getLong(sizeCol) / 1e6
                            val dateSec = cursor.getLong(dateCol)
                            val dateStr = sdf.format(Date(dateSec * 1000L))
                            found.add(
                                SessionItem(
                                    title = name,
                                    subtitle = "$dateStr  •  MediaStore Download",
                                    sizeStr = "%.1f MB".format(size),
                                    pathStr = "Downloads/PoseCam/$name",
                                    mediaUri = uri
                                )
                            )
                        }
                    }
                }
            } catch (e: Exception) {
                // Ignore query failures
            }
        }

        tabExportsBtn.text = "📦 Exported Files (${found.size})"
        items = found.sortedByDescending { it.title }
        renderList(getString(R.string.no_exports, pubDir.path))
    }

    private fun renderList(emptyMessage: String) {
        if (items.isEmpty()) {
            emptyView.text = emptyMessage
            emptyView.visibility = View.VISIBLE
            listView.visibility = View.GONE
        } else {
            emptyView.visibility = View.GONE
            listView.visibility = View.VISIBLE
            listView.adapter = object : BaseAdapter() {
                override fun getCount(): Int = items.size
                override fun getItem(position: Int): Any = items[position]
                override fun getItemId(position: Int): Long = position.toLong()
                override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
                    val view = convertView ?: LayoutInflater.from(this@SessionsActivity)
                        .inflate(R.layout.item_session, parent, false)
                    val item = items[position]
                    view.findViewById<TextView>(R.id.item_title).text = item.title
                    view.findViewById<TextView>(R.id.item_size).text = item.sizeStr
                    view.findViewById<TextView>(R.id.item_subtitle).text = item.subtitle
                    view.findViewById<TextView>(R.id.item_path).text = item.pathStr
                    return view
                }
            }
        }
    }

    private fun showRawSessionActions(item: SessionItem) {
        val dir = item.rawDir ?: return
        val actions = mutableListOf(
            "📦 Save to Public Downloads (ZIP)",
            "📤 Share Recording via Nearby / Apps",
            "📋 Copy Directory Path",
            "🔍 Inspect Capture Contents",
            "🗑️ Delete Recording"
        )
        AlertDialog.Builder(this)
            .setTitle(item.title)
            .setMessage("Path: ${dir.path}\nSize: ${item.sizeStr} (${item.subtitle})")
            .setItems(actions.toTypedArray()) { _, which ->
                when (which) {
                    0 -> saveZipToDownloads(dir, "${dir.name}.zip")
                    1 -> shareZip(dir, "${dir.name}.zip")
                    2 -> copyToClipboard("Directory Path", dir.absolutePath)
                    3 -> inspectDirectory(dir)
                    4 -> confirmDelete(dir)
                }
            }
            .setNegativeButton(R.string.close, null)
            .show()
    }

    private fun showExportFileActions(item: SessionItem) {
        val actions = mutableListOf(
            "📤 Share ZIP File",
            "📂 Open in Files App",
            "📋 Copy Full File Path",
            "🗑️ Delete Export"
        )
        AlertDialog.Builder(this)
            .setTitle(item.title)
            .setMessage("Location: ${item.pathStr}\nSize: ${item.sizeStr}")
            .setItems(actions.toTypedArray()) { _, which ->
                when (which) {
                    0 -> {
                        if (item.exportFile != null && item.exportFile.exists()) {
                            shareDirectFile(item.exportFile)
                        } else if (item.mediaUri != null) {
                            shareUri(item.mediaUri, item.title)
                        }
                    }
                    1 -> openDownloadsFolder()
                    2 -> copyToClipboard("Export Path", item.pathStr)
                    3 -> {
                        item.exportFile?.delete()
                        if (item.mediaUri != null) {
                            try { contentResolver.delete(item.mediaUri, null, null) } catch (_: Exception) {}
                        }
                        refresh()
                    }
                }
            }
            .setNegativeButton(R.string.close, null)
            .show()
    }

    private fun inspectDirectory(dir: File) {
        val files = dir.listFiles() ?: emptyArray()
        val frameCount = File(dir, "frames").listFiles()?.size ?: 0
        val posesExists = File(dir, "poses.csv").exists()
        val imuExists = File(dir, "imu.csv").exists()
        val intrinsicsExists = File(dir, "intrinsics.json").exists()

        val details = buildString {
            append("Directory: ${dir.name}\n\n")
            append("• Frames: $frameCount JPEG images\n")
            append("• ARCore Poses: ${if (posesExists) "✅ poses.csv present" else "❌ missing"}\n")
            append("• IMU Sensor Data: ${if (imuExists) "✅ imu.csv present" else "❌ missing"}\n")
            append("• Camera Intrinsics: ${if (intrinsicsExists) "✅ intrinsics.json present" else "❌ missing"}\n")
            append("• Total Files: ${files.size} items in session")
        }

        AlertDialog.Builder(this)
            .setTitle("Session Inspection")
            .setMessage(details)
            .setPositiveButton("OK", null)
            .show()
    }

    private fun shareDirectFile(file: File) {
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        shareUri(uri, file.name)
    }

    private fun shareUri(uri: Uri, title: String) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, "PoseCam 3D Scan: $title")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(send, "Share 3D Scan ZIP"))
    }

    private fun shareZip(dir: File, zipName: String) {
        val shared = File(cacheDir, "shared").apply { mkdirs() }
        shared.listFiles()?.forEach { it.delete() }
        val zip = File(shared, zipName)
        withProgress("Zipping ${dir.name}", { setMessage ->
            FileOutputStream(zip).use { out ->
                SessionZipper.zip(dir, out) { n, total -> setMessage("$n / $total files") }
            }
        }) { error ->
            if (error != null) {
                Toast.makeText(this, "Zip failed: $error", Toast.LENGTH_LONG).show()
                return@withProgress
            }
            shareDirectFile(zip)
        }
    }

    /** Public Downloads/PoseCam/, visible in any file manager and over USB (MTP). */
    private fun saveZipToDownloads(dir: File, zipName: String) {
        val pubDir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PoseCam")
        if (!pubDir.exists()) pubDir.mkdirs()
        val destFile = File(pubDir, zipName)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, zipName)
                put(MediaStore.Downloads.MIME_TYPE, "application/zip")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/PoseCam")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            if (uri == null) {
                Toast.makeText(this, "Could not create Downloads entry", Toast.LENGTH_LONG).show()
                return
            }
            withProgress("Saving $zipName to Downloads", { setMessage ->
                resolver.openOutputStream(uri)!!.use { out ->
                    SessionZipper.zip(dir, out) { n, total -> setMessage("Packing: $n / $total files") }
                }
                resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            }) { error ->
                if (error != null) {
                    resolver.delete(uri, null, null)
                    Toast.makeText(this, "Save failed: $error", Toast.LENGTH_LONG).show()
                } else {
                    onExportSuccess(zipName, destFile.absolutePath, uri)
                }
            }
        } else {
            withProgress("Saving $zipName to Downloads", { setMessage ->
                FileOutputStream(destFile).use { out ->
                    SessionZipper.zip(dir, out) { n, total -> setMessage("Packing: $n / $total files") }
                }
            }) { error ->
                if (error != null) {
                    Toast.makeText(this, "Save failed: $error", Toast.LENGTH_LONG).show()
                } else {
                    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", destFile)
                    onExportSuccess(zipName, destFile.absolutePath, uri)
                }
            }
        }
    }

    private fun onExportSuccess(fileName: String, targetPath: String, uri: Uri) {
        refresh()
        AlertDialog.Builder(this)
            .setTitle("📦 Export Ready!")
            .setMessage("Successfully saved to public Downloads:\n\n📂 $targetPath\n\nYou can access this file via the Files app or connect your phone to PC via USB cable to run 3D reconstruction.")
            .setPositiveButton("📤 Share File") { _, _ -> shareUri(uri, fileName) }
            .setNeutralButton("📂 Open Files") { _, _ -> openDownloadsFolder() }
            .setNegativeButton("OK", null)
            .show()
    }

    private fun openDownloadsFolder() {
        try {
            val intent = Intent(DownloadManager.ACTION_VIEW_DOWNLOADS)
            startActivity(intent)
        } catch (_: Exception) {
            try {
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "*/*"
                }
                startActivity(intent)
            } catch (e: Exception) {
                Toast.makeText(this, "Please open your phone's 'Files' app -> Downloads folder", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun showPcGuide() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.pc_guide_title))
            .setMessage(getString(R.string.pc_guide_body))
            .setPositiveButton("OK", null)
            .show()
    }

    private fun copyToClipboard(label: String, text: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText(label, text)
        clipboard.setPrimaryClip(clip)
        Toast.makeText(this, "Copied: $text", Toast.LENGTH_SHORT).show()
    }

    private fun confirmDelete(dir: File) {
        AlertDialog.Builder(this)
            .setTitle("Delete ${dir.name}?")
            .setMessage("This will permanently delete this raw session from the phone.\nPath: ${dir.path}")
            .setPositiveButton(R.string.delete) { _, _ ->
                dir.deleteRecursively()
                refresh()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun withProgress(title: String, work: ((String) -> Unit) -> Unit, done: (Throwable?) -> Unit) {
        val dialog = AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage("Starting…")
            .setCancelable(false)
            .show()
        executor.execute {
            val error = runCatching {
                work { message -> mainHandler.post { dialog.setMessage(message) } }
            }.exceptionOrNull()
            mainHandler.post {
                dialog.dismiss()
                done(error)
            }
        }
    }
}
