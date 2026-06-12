export async function apiGet(url) {
  const res = await fetch(url, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error((await safeReadError(res)) || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function apiPost(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload ?? {}),
  });

  if (!res.ok) {
    throw new Error((await safeReadError(res)) || `Request failed: ${res.status}`);
  }

  return res.json();
}

export async function safeReadError(res) {
  try {
    const payload = await res.json();
    return formatErrorPayload(payload) || JSON.stringify(payload);
  } catch {
    return parseErrorText(await res.text());
  }
}

function formatErrorPayload(payload) {
  if (!payload) {
    return "";
  }

  if (typeof payload === "string") {
    return parseErrorText(payload);
  }

  const parts = [];
  if (payload.error) {
    parts.push(payload.error);
  }
  if (payload.errorId) {
    parts.push(`Error ID: ${payload.errorId}`);
  }
  if (payload.details) {
    parts.push(payload.details);
  }

  return parts.join(" | ");
}

function parseErrorText(text) {
  if (!text) {
    return "";
  }

  try {
    return formatErrorPayload(JSON.parse(text)) || text;
  } catch {
    return text;
  }
}

export function uploadFiles(folder, files, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file, file.name);
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?folder=${encodeURIComponent(folder)}`);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) {
        return;
      }
      const percent = Math.round((event.loaded / event.total) * 100);
      onProgress(percent);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        const errorMessage = parseErrorText(xhr.responseText) || `Upload failed: ${xhr.status}`;
        reject(new Error(errorMessage));
      }
    };

    xhr.onerror = () => {
      reject(new Error("Upload failed due to a network error."));
    };

    xhr.send(formData);
  });
}

export async function downloadFiles(folder, files) {
  const res = await fetch(`/api/download?folder=${encodeURIComponent(folder)}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ files }),
  });

  if (!res.ok) {
    throw new Error((await safeReadError(res)) || `Download failed: ${res.status}`);
  }

  return res.blob();
}

export async function deleteFiles(folder, files) {
  const res = await fetch(`/api/delete?folder=${encodeURIComponent(folder)}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ files }),
  });

  if (!res.ok) {
    throw new Error((await safeReadError(res)) || `Delete failed: ${res.status}`);
  }

  return res.json();
}
