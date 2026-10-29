// Which monitoring facts a host can actually report (Phase 39).
//
// The metrics contract is one shape over two transports (`/proc` shell probes over
// SSH, `sysinfo` natively on a local tab), and fields a host cannot supply arrive
// as `null`. That is honest, but "null" alone does not tell the UI *why*, so the
// overlay treated every absent value the same way and produced two wrong things on
// Windows:
//
//   * load average rendered as "— / — / —", implying vterm failed to read a number
//     that in fact does not exist on Windows at all (there is no such kernel
//     concept, and `sysinfo` reports zeros there);
//   * an empty sensor list fell through to the "Install lm-sensors" call to action,
//     offering to apt-install a Linux package onto a Windows machine.
//
// So we key off the OS the host itself reported — `Metrics.os` is `uname -s` over
// SSH and `System::name()` locally, i.e. already a cross-transport discriminator —
// and let the UI distinguish "not measured yet" from "cannot exist here".
//
// Deliberately NOT a `hostOs()` lookup: that answers what OS *vterm* runs on, which
// is the wrong question for an SSH tab pointing at a Linux server.

/** Normalised host OS family, from the `os` field both collectors fill. */
export type HostOsFamily = "windows" | "macos" | "linux" | "bsd" | "unknown";

/**
 * Classify the raw `Metrics.os` string. SSH reports `uname -s` (`Linux`,
 * `Darwin`, `FreeBSD`, and on Git-Bash/Cygwin something like `MINGW64_NT-10.0`);
 * the local collector reports `System::name()` (`Windows`, `Darwin`, `Ubuntu`…).
 * An empty string means we have not polled yet — `unknown`, never a guess.
 */
export function hostOsFamily(os: string | null | undefined): HostOsFamily {
  const s = (os ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.includes("windows") || s.includes("mingw") || s.includes("msys") || s.includes("cygwin")) {
    return "windows";
  }
  if (s.includes("darwin") || s.includes("mac")) return "macos";
  if (s.includes("bsd")) return "bsd";
  if (s.includes("linux") || s.includes("ubuntu") || s.includes("debian")) return "linux";
  return "unknown";
}

/**
 * Whether this host has a load-average concept at all. Windows does not: there is
 * no equivalent kernel counter, so the card is hidden rather than shown full of
 * dashes. Unknown hosts keep the card — absent data there really does mean "not
 * read yet", and hiding it would make a transient blank look permanent.
 */
export function supportsLoadAverage(os: string | null | undefined): boolean {
  return hostOsFamily(os) !== "windows";
}

/**
 * Whether offering to install `lm-sensors` makes sense. It is a Linux package
 * reading `/sys/class/hwmon`, so the offer is only ever correct on Linux. On
 * macOS/BSD/Windows the honest answer is "this host exposes no readable sensors",
 * with no install button.
 */
export function supportsSensorsInstall(os: string | null | undefined): boolean {
  return hostOsFamily(os) === "linux";
}

/**
 * Whether CPU temperature can be read here *in principle*. Windows exposes
 * thermal data only through WMI's `MSAcpi_ThermalZoneTemperature` (needs admin,
 * unimplemented by most vendor firmware) or a kernel-level driver like
 * LibreHardwareMonitor — neither is something vterm can honestly do from an
 * offline, unprivileged process. So we say "not available on this host" instead
 * of pretending a reading is merely missing.
 */
export function supportsTemperature(os: string | null | undefined): boolean {
  return hostOsFamily(os) !== "windows";
}
