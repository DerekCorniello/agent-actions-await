export type CliArgs =
    | { command: "help" }
    | { command: "doctor" }
    | {
          command: "start";
          pollingOnly: boolean;
          pollIntervalSeconds?: number;
          pollGraceSeconds?: number;
      };

function parseSeconds(flag: string, value: string | undefined, minimum: number): number {
    if (value === undefined || !/^\d+$/.test(value))
        throw new Error(`${flag} requires an integer number of seconds`);
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds < minimum || seconds > 3600) {
        throw new Error(`${flag} must be between ${minimum} and 3600 seconds`);
    }
    return seconds;
}

export function parseCliArgs(args: string[]): CliArgs {
    if (args.includes("--help") || args.includes("-h")) return { command: "help" };
    if (args.includes("doctor")) {
        if (args.length !== 1) throw new Error("doctor does not accept other options");
        return { command: "doctor" };
    }
    let pollingOnly = false;
    let pollIntervalSeconds: number | undefined;
    let pollGraceSeconds: number | undefined;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--polling-only") {
            if (pollingOnly) throw new Error("--polling-only was provided more than once");
            pollingOnly = true;
        } else if (arg === "--poll-interval-seconds") {
            if (pollIntervalSeconds !== undefined)
                throw new Error(`${arg} was provided more than once`);
            pollIntervalSeconds = parseSeconds(arg, args[++index], 1);
        } else if (arg === "--poll-grace-seconds") {
            if (pollGraceSeconds !== undefined)
                throw new Error(`${arg} was provided more than once`);
            pollGraceSeconds = parseSeconds(arg, args[++index], 0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return {
        command: "start",
        pollingOnly,
        ...(pollIntervalSeconds !== undefined ? { pollIntervalSeconds } : {}),
        ...(pollGraceSeconds !== undefined ? { pollGraceSeconds } : {}),
    };
}
