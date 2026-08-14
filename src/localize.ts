export type LocalizationArgs = Readonly<Record<string, string | number | boolean>>;
type Translator = (message: string, args: LocalizationArgs) => string;

let translator: Translator = (message, args) =>
    message.replace(/\{([^{}]+)\}/gu, (placeholder, key: string) =>
        Object.prototype.hasOwnProperty.call(args, key) ? String(args[key]) : placeholder,
    );

export function configureLocalization(next: Translator): void {
    translator = next;
}

export function t(message: string, args: LocalizationArgs = {}): string {
    return translator(message, args);
}
