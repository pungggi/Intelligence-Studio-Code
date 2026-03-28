/// Build script that verifies the shared corecode.wit file is reachable before
/// wit_bindgen::generate! tries to use it.  Gives a clear error instead of a
/// confusing proc-macro failure when the repo layout has changed or the example
/// is built in isolation.
fn main() {
    let manifest_dir =
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set by Cargo");

    let wit_rel = "../../src/app/src-tauri/wit/corecode.wit";
    let wit_path = std::path::Path::new(&manifest_dir).join(wit_rel);

    if !wit_path.exists() {
        panic!(
            "\n\
            corecode.wit not found at the expected location.\n\
            Expected: {}\n\
            Ensure you are building from within the Intelligence-Studio-Code repository\n\
            and that the host crate has been set up (src/app/src-tauri/wit/ must exist).\n",
            wit_path.display()
        );
    }

    // Re-run this build script whenever the WIT file changes.
    println!("cargo:rerun-if-changed={}", wit_path.display());
}
