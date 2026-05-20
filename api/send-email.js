
    console.error('send-email: unexpected error:', err);
    return res.status(500).json({ error: 'Unexpected error', detail: err.message });
  }
};
