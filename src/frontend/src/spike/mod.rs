//! Spike / proof-of-concept module.
//!
//! This module contains **experimental** code that is not yet production-ready.
//! Everything here is subject to removal or significant refactoring once the
//! concepts have been validated or superseded by a proper implementation.
//!
//! # Submodules
//!
//! - [`glyph_atlas`] – Experimental glyph-atlas management: packs rendered
//!   glyphs into a GPU texture atlas for efficient text rendering. Not yet
//!   integrated with the main rendering pipeline.
//! - [`text_pipeline`] – Experimental text-rendering pipeline: drives shaping,
//!   rasterisation, and draw-call generation on top of `glyph_atlas`. Still
//!   evolving; the public API should be treated as unstable.
//!
//! # Stability policy
//!
//! **Do not depend on any public symbol from this module in production paths.**
//! Code here may be deleted, renamed, or broken at any time without a
//! deprecation period.
//!
//! # TODOs
//!
//! - Promote `glyph_atlas` to a first-class rendering subsystem once the atlas
//!   eviction strategy is finalised.
//! - Evaluate whether `text_pipeline` should replace or extend the existing
//!   text-rendering code before removing this spike.
//! - Add integration tests before graduating either submodule out of spike.

pub mod glyph_atlas;
pub mod text_pipeline;
