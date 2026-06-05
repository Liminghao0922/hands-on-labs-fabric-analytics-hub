import { useEffect, useMemo, useState } from "react";
import { apiGet, deleteFiles, downloadFiles, uploadFiles } from "../apiClient";

export default function FilesPage() {
	const [folders, setFolders] = useState([]);
	const [selectedFolder, setSelectedFolder] = useState("");
	const [files, setFiles] = useState([]);
	const [selectedFiles, setSelectedFiles] = useState({});
	const [uploadProgress, setUploadProgress] = useState(0);
	const [uploading, setUploading] = useState(false);
	const [loadingFolders, setLoadingFolders] = useState(true);
	const [loadingFiles, setLoadingFiles] = useState(false);
	const [error, setError] = useState("");

	const hasSelection = useMemo(() => Object.values(selectedFiles).some(Boolean), [selectedFiles]);

	useEffect(() => {
		let mounted = true;

		(async () => {
			try {
				const foldersData = await apiGet("/api/folders");
				if (mounted) {
					setFolders(foldersData.folders || []);
				}
			} catch (err) {
				if (mounted) {
					setError(err.message || "Failed to load folders.");
				}
			} finally {
				if (mounted) {
					setLoadingFolders(false);
				}
			}
		})();

		return () => {
			mounted = false;
		};
	}, []);

	const loadFolder = async (folderName) => {
		setError("");
		setSelectedFolder(folderName);
		setSelectedFiles({});
		setLoadingFiles(true);

		try {
			const data = await apiGet(`/api/files?folder=${encodeURIComponent(folderName)}`);
			setFiles(data.files || []);
		} catch (err) {
			setError(err.message || "Failed to list files.");
		} finally {
			setLoadingFiles(false);
		}
	};

	const toggleSelect = (fileName) => {
		setSelectedFiles((prev) => ({ ...prev, [fileName]: !prev[fileName] }));
	};

	const onUpload = async (event) => {
		const payload = event.target.files;
		if (!payload || payload.length === 0 || !selectedFolder) {
			return;
		}

		setUploading(true);
		setUploadProgress(0);
		setError("");

		try {
			await uploadFiles(selectedFolder, payload, setUploadProgress);
			const data = await apiGet(`/api/files?folder=${encodeURIComponent(selectedFolder)}`);
			setFiles(data.files || []);
		} catch (err) {
			setError(err.message || "Upload failed.");
		} finally {
			setUploading(false);
			event.target.value = "";
		}
	};

	const onDownload = async () => {
		const names = Object.entries(selectedFiles)
			.filter(([, checked]) => checked)
			.map(([name]) => name);

		if (names.length === 0 || !selectedFolder) {
			return;
		}

		setError("");
		try {
			const blob = await downloadFiles(selectedFolder, names);
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "selected-files.zip";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
		} catch (err) {
			setError(err.message || "Download failed.");
		}
	};

	const onDelete = async () => {
		const names = Object.entries(selectedFiles)
			.filter(([, checked]) => checked)
			.map(([name]) => name);

		if (names.length === 0 || !selectedFolder) {
			return;
		}

		const confirmed = window.confirm(`Delete ${names.length} selected file(s)? This cannot be undone.`);
		if (!confirmed) {
			return;
		}

		setError("");
		try {
			await deleteFiles(selectedFolder, names);
			const data = await apiGet(`/api/files?folder=${encodeURIComponent(selectedFolder)}`);
			setFiles(data.files || []);
			setSelectedFiles({});
		} catch (err) {
			setError(err.message || "Delete failed.");
		}
	};

	return (
		<>
			<section className="card">
				<h2>Available Folders</h2>
				{loadingFolders ? (
					<div className="loading-container">
						<div className="spinner"></div>
						<span>Loading accessible folders...</span>
					</div>
				) : (
					<div className="actions">
						{folders.map((folder) => (
							<button key={folder} className={`btn ${selectedFolder === folder ? "btn-active" : ""}`} onClick={() => loadFolder(folder)} disabled={loadingFiles}>
								{folder}
							</button>
						))}
						{folders.length === 0 && <span className="hint">No folders available.</span>}
					</div>
				)}
			</section>

			{selectedFolder && (
				<section className="card">
					<div className="panel-head">
						<h2>Files in {selectedFolder}</h2>
						<div className="actions">
							<label className="btn" htmlFor="uploadInput">Upload Files</label>
							<input id="uploadInput" type="file" multiple onChange={onUpload} className="hidden" disabled={!selectedFolder || uploading} />
							<button className="btn btn-ghost" disabled={!hasSelection} onClick={onDownload}>Download Selected (ZIP)</button>
							<button className="btn btn-ghost" disabled={!hasSelection} onClick={onDelete}>Delete Selected</button>
						</div>
					</div>

					{loadingFiles ? (
						<div className="loading-container section-center">
							<div className="spinner"></div>
							<span>Loading files...</span>
						</div>
					) : (
						<>
							{uploading && (
								<div className="progress-wrap">
									<div className="progress-bar" style={{ width: `${uploadProgress}%` }} />
									<span className="progress-text">{uploadProgress}%</span>
								</div>
							)}

							<table>
								<thead>
									<tr>
										<th></th>
										<th>File Name</th>
										<th>Modified Time</th>
										<th>Type</th>
										<th className="right">Size (Bytes)</th>
									</tr>
								</thead>
								<tbody>
									{files.map((file) => (
										<tr key={file.name}>
											<td>
												<input type="checkbox" checked={!!selectedFiles[file.name]} onChange={() => toggleSelect(file.name)} />
											</td>
											<td>{file.name}</td>
											<td>{file.modifiedTime || "-"}</td>
											<td>{file.type || "file"}</td>
											<td className="right">{file.size || 0}</td>
										</tr>
									))}
									{files.length === 0 && (
										<tr>
											<td colSpan={5} className="hint">No files in this folder.</td>
										</tr>
									)}
								</tbody>
							</table>
						</>
					)}
				</section>
			)}

			{error && <section className="card error">{error}</section>}
		</>
	);
}
