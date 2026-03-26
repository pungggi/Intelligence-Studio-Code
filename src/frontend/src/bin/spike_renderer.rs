//! Spike 1: wgpu Text-Rendering Prototype
//!
//! Validates that wgpu can render 1000+ lines of monospaced text
//! at < 16ms frame time with smooth scrolling.
//!
//! Run: cargo run --bin spike-renderer

use anyhow::Result;
use corecode_frontend::spike::glyph_atlas::GlyphAtlas;
use corecode_frontend::spike::text_pipeline::TextPipeline;
use std::sync::Arc;
use std::time::Instant;
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalSize};
use winit::event::{ElementState, KeyEvent, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowAttributes, WindowId};

/// Generate test content: 1000 lines of code-like text
fn generate_test_content(line_count: usize) -> Vec<String> {
    let templates = [
        "fn process_item(id: u64, data: &[u8]) -> Result<Output> {",
        "    let parsed = Parser::new(data).parse()?;",
        "    if parsed.is_valid() {",
        "        let result = transform(parsed, Config::default());",
        "        cache.insert(id, result.clone());",
        "        Ok(result)",
        "    } else {",
        "        Err(Error::InvalidInput(id))",
        "    }",
        "}",
        "",
        "/// Documentation comment for the next function",
        "pub struct DataProcessor<T: Send + Sync> {",
        "    buffer: Vec<T>,",
        "    capacity: usize,",
        "    metrics: Arc<Mutex<Metrics>>,",
        "}",
        "",
        "impl<T: Send + Sync> DataProcessor<T> {",
        "    pub fn new(capacity: usize) -> Self {",
        "        Self {",
        "            buffer: Vec::with_capacity(capacity),",
        "            capacity,",
        "            metrics: Arc::new(Mutex::new(Metrics::default())),",
        "        }",
        "    }",
        "}",
        "",
        "// TODO: implement batch processing pipeline",
        "const MAX_RETRIES: u32 = 3;",
    ];

    (0..line_count)
        .map(|i| {
            let template = templates[i % templates.len()];
            if template.is_empty() {
                String::new()
            } else {
                format!("{:>4} | {}", i + 1, template)
            }
        })
        .collect()
}

struct FrameStats {
    frame_times: Vec<f64>,
    last_report: Instant,
}

impl FrameStats {
    fn new() -> Self {
        Self {
            frame_times: Vec::with_capacity(1000),
            last_report: Instant::now(),
        }
    }

    fn record(&mut self, frame_time_ms: f64) {
        self.frame_times.push(frame_time_ms);

        if self.last_report.elapsed().as_secs() >= 2 {
            self.report();
            self.frame_times.clear();
            self.last_report = Instant::now();
        }
    }

    fn report(&self) {
        if self.frame_times.is_empty() {
            return;
        }
        let count = self.frame_times.len();
        let avg = self.frame_times.iter().sum::<f64>() / count as f64;
        let max = self.frame_times.iter().cloned().fold(0.0_f64, f64::max);
        let min = self.frame_times.iter().cloned().fold(f64::MAX, f64::min);

        let mut sorted = self.frame_times.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p95 = sorted[(count as f64 * 0.95) as usize];
        let p99 = sorted[(count as f64 * 0.99).min((count - 1) as f64) as usize];

        println!(
            "[FrameStats] frames={count} avg={avg:.2}ms min={min:.2}ms max={max:.2}ms p95={p95:.2}ms p99={p99:.2}ms fps={:.0}",
            1000.0 / avg
        );

        if p95 < 16.0 {
            println!("[FrameStats] PASS: p95 < 16ms target");
        } else {
            println!("[FrameStats] FAIL: p95 >= 16ms target");
        }
    }

    fn final_report(&self) {
        println!("\n=== FINAL SPIKE 1 RESULTS ===");
        self.report();
        println!("=============================\n");
    }
}

struct AppState {
    window: Option<Arc<Window>>,
    gpu: Option<GpuState>,
    text_pipeline: Option<TextPipeline>,
    glyph_atlas: Option<GlyphAtlas>,
    lines: Vec<String>,
    scroll_offset: f32,
    frame_stats: FrameStats,
    startup_time: Instant,
    first_frame: bool,
}

struct GpuState {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    size: PhysicalSize<u32>,
}

impl AppState {
    fn new() -> Self {
        Self {
            window: None,
            gpu: None,
            text_pipeline: None,
            glyph_atlas: None,
            lines: generate_test_content(1000),
            scroll_offset: 0.0,
            frame_stats: FrameStats::new(),
            startup_time: Instant::now(),
            first_frame: true,
        }
    }

    fn init_gpu(&mut self, window: Arc<Window>) {
        let size = window.inner_size();

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::all(),
            ..Default::default()
        });

        let surface = instance.create_surface(window.clone()).unwrap();

        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }))
        .expect("Failed to find GPU adapter");

        println!(
            "[GPU] Adapter: {} ({:?})",
            adapter.get_info().name,
            adapter.get_info().backend
        );

        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("CoreCode Device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                ..Default::default()
            },
            None,
        ))
        .expect("Failed to create device");

        let surface_caps = surface.get_capabilities(&adapter);
        let surface_format = surface_caps
            .formats
            .iter()
            .find(|f| f.is_srgb())
            .copied()
            .unwrap_or(surface_caps.formats[0]);

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width: size.width,
            height: size.height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: surface_caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        // Build glyph atlas
        let mut glyph_atlas = GlyphAtlas::new(14.0);
        let atlas_texture = glyph_atlas.build_atlas_texture(&device, &queue);

        // Build text pipeline
        let text_pipeline = TextPipeline::new(
            &device,
            surface_format,
            &atlas_texture,
            size.width,
            size.height,
        );

        self.glyph_atlas = Some(glyph_atlas);
        self.text_pipeline = Some(text_pipeline);
        self.gpu = Some(GpuState {
            surface,
            device,
            queue,
            config,
            size,
        });
        self.window = Some(window);
    }

    fn render(&mut self) {
        let frame_start = Instant::now();

        let gpu = self.gpu.as_ref().unwrap();
        let text_pipeline = self.text_pipeline.as_mut().unwrap();
        let glyph_atlas = self.glyph_atlas.as_ref().unwrap();

        let output = match gpu.surface.get_current_texture() {
            Ok(t) => t,
            Err(wgpu::SurfaceError::Lost) => {
                gpu.surface.configure(&gpu.device, &gpu.config);
                return;
            }
            Err(wgpu::SurfaceError::OutOfMemory) => {
                eprintln!("[GPU] Out of memory!");
                return;
            }
            Err(e) => {
                eprintln!("[GPU] Surface error: {e:?}");
                return;
            }
        };

        let view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        // Calculate visible lines based on scroll offset
        let line_height = glyph_atlas.line_height();
        let visible_height = gpu.size.height as f32;
        let first_visible_line = (self.scroll_offset / line_height).floor() as usize;
        let visible_line_count = (visible_height / line_height).ceil() as usize + 1;
        let last_visible_line =
            (first_visible_line + visible_line_count).min(self.lines.len());

        // Build vertex data for visible lines
        let y_offset = -(self.scroll_offset % line_height);
        text_pipeline.prepare_lines(
            &gpu.device,
            &gpu.queue,
            glyph_atlas,
            &self.lines[first_visible_line..last_visible_line],
            y_offset,
            gpu.size.width as f32,
            gpu.size.height as f32,
        );

        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Render Encoder"),
            });

        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Text Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.12,
                            g: 0.12,
                            b: 0.14,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            text_pipeline.render(&mut render_pass);
        }

        gpu.queue.submit(std::iter::once(encoder.finish()));
        output.present();

        let frame_time = frame_start.elapsed().as_secs_f64() * 1000.0;

        if self.first_frame {
            let startup_ms = self.startup_time.elapsed().as_secs_f64() * 1000.0;
            println!("[Startup] First frame rendered in {startup_ms:.0}ms");
            if startup_ms < 500.0 {
                println!("[Startup] PASS: < 500ms target");
            } else {
                println!("[Startup] FAIL: >= 500ms target");
            }
            self.first_frame = false;
        }

        self.frame_stats.record(frame_time);
    }

    fn resize(&mut self, new_size: PhysicalSize<u32>) {
        if new_size.width == 0 || new_size.height == 0 {
            return;
        }
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.size = new_size;
            gpu.config.width = new_size.width;
            gpu.config.height = new_size.height;
            gpu.surface.configure(&gpu.device, &gpu.config);

            if let Some(tp) = self.text_pipeline.as_mut() {
                tp.resize(&gpu.queue, new_size.width, new_size.height);
            }
        }
    }

    fn scroll(&mut self, delta: f32) {
        let line_height = self
            .glyph_atlas
            .as_ref()
            .map(|a| a.line_height())
            .unwrap_or(20.0);
        let max_scroll = (self.lines.len() as f32 - 1.0) * line_height;
        self.scroll_offset = (self.scroll_offset + delta).clamp(0.0, max_scroll);
        if let Some(w) = &self.window {
            w.request_redraw();
        }
    }
}

impl ApplicationHandler for AppState {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }

        let attrs = WindowAttributes::default()
            .with_title("CoreCode - Spike 1: Text Rendering")
            .with_inner_size(LogicalSize::new(1200.0, 800.0));

        let window = Arc::new(event_loop.create_window(attrs).unwrap());
        self.init_gpu(window.clone());

        println!(
            "[Init] Window created, {} lines loaded",
            self.lines.len()
        );

        window.request_redraw();
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => {
                self.frame_stats.final_report();
                event_loop.exit();
            }
            WindowEvent::Resized(physical_size) => {
                self.resize(physical_size);
            }
            WindowEvent::RedrawRequested => {
                self.render();
                if let Some(w) = &self.window {
                    w.request_redraw();
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let scroll_amount = match delta {
                    MouseScrollDelta::LineDelta(_, y) => -y * 60.0,
                    MouseScrollDelta::PixelDelta(pos) => -pos.y as f32,
                };
                self.scroll(scroll_amount);
            }
            WindowEvent::KeyboardInput {
                event:
                    KeyEvent {
                        logical_key,
                        state: ElementState::Pressed,
                        ..
                    },
                ..
            } => match logical_key.as_ref() {
                Key::Named(NamedKey::Escape) => {
                    self.frame_stats.final_report();
                    event_loop.exit();
                }
                Key::Named(NamedKey::PageDown) => self.scroll(600.0),
                Key::Named(NamedKey::PageUp) => self.scroll(-600.0),
                Key::Named(NamedKey::ArrowDown) => self.scroll(60.0),
                Key::Named(NamedKey::ArrowUp) => self.scroll(-60.0),
                _ => {}
            },
            _ => {}
        }
    }
}

fn main() -> Result<()> {
    env_logger::init();
    println!("=== CoreCode Spike 1: wgpu Text Rendering ===\n");

    let event_loop = EventLoop::new()?;
    event_loop.set_control_flow(ControlFlow::Poll);

    let mut app = AppState::new();
    event_loop.run_app(&mut app)?;

    Ok(())
}
