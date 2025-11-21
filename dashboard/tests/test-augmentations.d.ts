// Add a scoped type augmentation for jest-dom matchers so tests can use `toBeInTheDocument` etc.
// This is a limited set targeted to tests in the `dashboard/tests/` directory.

import '@testing-library/jest-dom';

declare global {
    namespace jest {
        interface Matchers<R> {
            toBeInTheDocument(): R;
            toBeDisabled(): R;
            toHaveValue(expected?: any): R;
            toHaveTextContent(expected: string | RegExp): R;
        }
    }
}

export { };
