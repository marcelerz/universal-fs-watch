/**
 * Platform independent file watcher switching between watchman and chokidar.
 *
 * @format
 */

import WatchmanClient, {
	allOf,
	type,
	suffix,
	not,
	Type,
	dirname,
	name,
} from "watchman-wrapper";
import chokidar from "chokidar";

type ChangeType = "add" | "delete" | "change";
export type FileInfo = { path: string; type: ChangeType };
type Callback = (init: boolean, files: FileInfo[]) => void;

class UniversalFSWatch {
	private rootPath: string;
	private useWatchman: boolean;
	private isShutdown: boolean;

	private watchman: WatchmanClient | null = null;
	private chokidarFSWatcher: chokidar.FSWatcher[] = [];

	constructor(rootPath: string) {
		this.rootPath = rootPath;
		this.useWatchman = WatchmanClient.exists();
		this.isShutdown = false;
	}

	init(): void {
		if (this.useWatchman) {
			this.initWatchman();
		}
	}

	shutdown(): void {
		this.isShutdown = true;
	}

	listenTo(
		name: string,
		path: string,
		extensions: string[],
		ignoreFiles: string[],
		ignoreDirs: string[],
		cb: Callback,
	): void {
		if (this.useWatchman) {
			this.listenWithWatchman(
				name,
				path,
				extensions,
				ignoreFiles,
				ignoreDirs,
				cb,
			);
		} else {
			this.listenWithChokidar(
				name,
				path,
				extensions,
				ignoreFiles,
				ignoreDirs,
				cb,
			);
		}
	}

	private initWatchman(): WatchmanClient {
		if (this.watchman != null) {
			return this.watchman;
		}

		console.info("Initialize Watchman...");
		const watchman = new WatchmanClient({ debug: false, printWarnings: true });
		this.watchman = watchman;

		// Subscribe to events
		console.info("Listen to events...");
		watchman.onConnect(() => {
			console.info("Watchman connected.");
		});
		watchman.onEnd(() => {
			console.info("Watchman disconnected.");
		});
		watchman.onError((event) => {
			console.error("Error", event.error);
		});
		watchman.onLog((event) => {
			console.log("Log:", event.log);
		});

		// Watch for changes in root directory
		console.info("Watch root...");
		watchman.watchProject(this.rootPath);

		return watchman;
	}

	private listenWithWatchman(
		listenName: string,
		path: string,
		extensions: string[],
		ignoreFiles: string[],
		ignoreDirs: string[],
		cb: Callback,
	): void {
		const watchman = this.initWatchman();
		let fileHashMap: Record<string, boolean> = {};

		const pattern = [type(Type.RegularFile), suffix(extensions)];
		if (ignoreFiles.length > 0) {
			pattern.push(not(name(ignoreFiles, { scope: "wholename" })));
		}
		if (ignoreDirs.length > 0) {
			ignoreDirs.forEach((dir) => {
				pattern.push(not(dirname(dir)));
			});
		}

		watchman.subscribe(
			path,
			listenName,
			["name", "exists"],
			async (event) => {
				if (!event.files) return;

				if (event.init) {
					console.log(`${listenName} folder watch initialized.`);
					fileHashMap = event.files.reduce(
						(acc: Record<string, boolean>, file) => {
							if (typeof file.name === "string") {
								acc[file.name] = true;
							}
							return acc;
						},
						{},
					);

					if (!this.isShutdown) {
						cb(true, []);
					}
				} else {
					console.log(`${listenName} change triggered...`);

					const files = [];
					for (const file of event.files) {
						if (
							typeof file.name === "string" &&
							typeof file.exists === "boolean"
						) {
							let type: ChangeType;
							if (file.exists) {
								if (fileHashMap[file.name]) {
									type = "change";
								} else {
									fileHashMap[file.name] = true;
									type = "add";
								}
							} else {
								delete fileHashMap[file.name];
								type = "delete";
							}
							files.push({ path: file.name, type });
						}
					}

					if (!this.isShutdown) {
						cb(false, files);
					}
				}
			},
			{
				expression: allOf(...pattern),
			},
		);
	}

	private listenWithChokidar(
		listenName: string,
		path: string,
		extensions: string[],
		ignoreFiles: string[],
		ignoreDirs: string[],
		cb: Callback,
	): void {
		const fileHashMap: Record<string, boolean> = {};

		const ignoreList: string[] = [];
		ignoreFiles.forEach((file) => {
			ignoreList.push(file);
		});
		ignoreDirs.forEach((dir) => {
			ignoreList.push(`${dir}/**`);
		});
		const paths = extensions.map((extension) => `${path}/**/*.${extension}`);

		const watch = chokidar.watch(paths, {
			persistent: true,
			cwd: path,
			ignored: ignoreList,
		});
		let initialized = false;

		let timer: NodeJS.Timer | null = null;
		let changes: { path: string; type: ChangeType }[] = [];
		let wasInitialized = false;
		const changeTriggered = (path: string, type: ChangeType): void => {
			changes.push({ path, type });
			if (timer != null) {
				clearTimeout(timer);
				timer = null;
			}

			if (initialized && !wasInitialized) {
				console.log(`${listenName} folder watch initialized.`);

				if (!this.isShutdown) {
					cb(true, changes);
				}

				changes = [];
				wasInitialized = true;
			} else {
				timer = setTimeout(() => {
					if (this.isShutdown) {
						return;
					}

					if (wasInitialized) {
						console.log(`${listenName} change triggered...`);
						cb(false, changes);
					} else {
						console.log(`${listenName} folder watch initialized.`);
						cb(true, changes);
					}
					changes = [];
					wasInitialized = true;
				}, 100);
			}
		};

		watch.on("add", (path) => {
			fileHashMap[path] = true;
			changeTriggered(path, "add");
		});
		watch.on("change", (path) => {
			fileHashMap[path] = true;
			changeTriggered(path, "change");
		});
		watch.on("unlink", (path) => {
			if (initialized) {
				delete fileHashMap[path];
			}
			changeTriggered(path, "delete");
		});

		watch.on("ready", () => {
			initialized = true;
		});
		watch.on("error", (err) => {
			console.error("Error", err);
		});

		this.chokidarFSWatcher.push(watch);
	}
}

export default UniversalFSWatch;
